import { has_destroy, struct_needs_auto_destroy } from "../build_common/destroy_analysis.ts";
import emission_label from "../build_common/emission_label.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import { is_built_in_type } from "../built_in_types.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import build_node from "./build_node.ts";
import {
	ensure_concurrency_runtime,
	spawn_arg_c_types,
	spawn_arg_types,
} from "./build_spawn_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import { materialize_func_value } from "./utils/closure.ts";
import { emit_closure_env_type } from "./utils/closure_env.ts";

/**
 * The compiler-special `Thread(fn(args))` / `Fiber(fn(args))` constructor
 * (docs/CLOSURE_PLAN.md Phase 3b): the construction packs the wrapped call's
 * arguments EAGERLY into a task environment, allocates the result slot,
 * cancel flag, and future, and builds the task closure — a heap descriptor
 * over that environment (the same ABI every lambda lowers to; the runtime's
 * submit/fiber/detach seams all speak it since Phase 3a). The expression
 * yields a heap `Thread<T>` / `Fiber<T>` instance carrying the handles — a
 * real, storable value whose `#destroy` enforces must-start. The launch
 * (`.start()` / `.detach()` / `.start_on(buf)` / a nursery's `.start(...)`)
 * submits the packed closure and transfers the handles out of the instance.
 */

/** The trampoline/descriptor C types for one spawn site. */
export interface SpawnTaskC {
	returns_value: boolean;
	c_ret_type: string;
	slot_c_type: string;
}

/** Resolve the trampoline's return/result-slot C types from the wrapped
 *  call's return type (the same rules every spawn emitter used pre-3b). */
export function spawn_task_c_types(
	function_return_type: { name?: string } | undefined,
	status: BuildStatus,
): SpawnTaskC {
	const return_type_name = function_return_type?.name;
	const returns_value = !!(
		return_type_name &&
		return_type_name !== "void" &&
		return_type_name !== "?"
	);
	const is_class_ret =
		returns_value && !!status.structs.find((s) => s.name === return_type_name && s.is_class);
	const is_trait_ret = returns_value && !!status.traits.find((t) => t.name === return_type_name);
	const c_ret_type = !returns_value
		? "void"
		: is_class_ret || is_trait_ret
			? `struct ${return_type_name} *`
			: c_type(return_type_name!);
	// The result slot carries the full return VALUE — a fat `string` result is
	// a 16-byte nomen_string, so the cell is typed (and sized) as the return
	// type, not a fixed unsigned long long (which truncated the len half).
	const slot_c_type = returns_value ? c_ret_type : "unsigned long long";
	return { returns_value, c_ret_type, slot_c_type };
}

/**
 * Emit (headers, file scope) the per-site task body for a wrapped call:
 * the env struct (packed args + result slot + cancel flag + future), the
 * closure-body trampoline (`void (*)(struct nomen_closure *)` — the code
 * receives the closure itself and reaches the env through it), and the
 * site's static descriptor template. Shared by Thread and Fiber
 * constructions.
 */
export function emit_spawn_task_body(
	call: FunctionCallNode,
	status: BuildStatus,
	id: number,
	task_c: SpawnTaskC,
): {
	struct_name: string;
	desc_name: string;
	arg_c_types: string[];
	func_name: string;
	owned_args: OwnedArg[];
} {
	const func_name = c_function_name(emission_label(call.resolved_function ?? call));
	const struct_name = `__nomen_spawn_${id}_args`;
	const tramp_name = `__nomen_spawn_${id}_trampoline`;
	const desc_name = `__nomen_spawn_${id}_descriptor`;
	const destroy_name = `__nomen_spawn_${id}_env_destroy`;
	const arg_c_types = spawn_arg_c_types(call, status);
	const arg_types = spawn_arg_types(call, status);
	const { returns_value, c_ret_type, slot_c_type } = task_c;

	// Ownership classification (Phase 3d): the env is an OWNING struct. A
	// fat `string` arg is duplicated at pack time (a raw pair copy would
	// alias and dangle the moment the caller's scope exit ran) and freed by
	// the env destructor. An owning value-struct arg (a `#destroy`, owning
	// fields, or heap string fields) is copied and `<T>_destroy`ed — the
	// env owns its copy. Class and trait args stay shared pointers (the
	// Sendable contract).
	const arg_c_types_with_owned = arg_c_types.map((ct, i) => {
		const st = arg_types[i]?.name
			? status.structs.find(
					(s) =>
						s.name === arg_types[i].name &&
						!s.is_class &&
						!s.is_simple_type &&
						!is_built_in_type(arg_types[i].name),
				)
			: undefined;
		return st ? `struct ${st.name} *` : ct;
	});
	const owned_args: OwnedArg[] = arg_types.map((t, i) => {
		if (t.name === "string" && !t.is_view && !t.is_array) {
			return { index: i, kind: "string" as const };
		}
		if (!t.is_view && !t.is_array && t.name) {
			const st = status.structs.find((s) => s.name === t.name && !s.is_class && !s.is_simple_type);
			if (st) {
				// The callee ABI passes value structs by POINTER, and an
				// inline struct field would be incomplete at the env's
				// definition point — the same shape the capture machinery
				// chose (Phase 2c): the env holds a malloc'd COPY; when the
				// struct owns anything the destructor destroys + frees it.
				// Top-level string fields are deep-copied at pack (a raw
				// byte copy would alias the donor's buffers — rodata for a
				// literal field — and <T>_destroy would free them
				// invalidly).
				const owns = has_destroy(st) || struct_needs_auto_destroy(st, status);
				const string_fields = st.fields
					.filter(
						(f) =>
							f.type.name === "string" && !f.type.is_view && !f.type.is_array && !f.type.is_ref,
					)
					.map((f) => f.name);
				return {
					index: i,
					kind: "struct" as const,
					struct_name: st.name,
					owns,
					string_fields,
				};
			}
		}
		return { index: i, kind: "plain" as const };
	});

	// Forward-declare the wrapped function before the trampoline. The
	// trampoline is a full function definition appended to the headers, and
	// it may be appended BEFORE the function's own prototype lands there —
	// struct methods are built before free functions, so a spawn inside a
	// method (e.g. a monomorphized generic body) emits its trampoline ahead
	// of any free function declared after the generic struct. A compatible
	// redeclaration is legal C, so emitting this unconditionally is safe.
	let header = `${c_ret_type} ${func_name}(${arg_c_types_with_owned.join(", ")});\n`;

	header += `struct ${struct_name} {\n`;
	for (let i = 0; i < arg_c_types_with_owned.length; i++) {
		header += `\t${arg_c_types_with_owned[i]} arg${i};\n`;
	}
	header += `\t${slot_c_type} *result_slot;\n`;
	header += `\tunsigned long long *cancel_flag;\n`;
	header += `\tstruct nomen_future *future;\n`;
	header += `};\n`;

	// The env destructor (Phase 3d): frees each duplicated string and runs
	// `<T>_destroy` on the env's owning-struct copies. Wired through the
	// descriptor's destroy_env slot, so every release path (future release,
	// daemon teardown) reclaims the env's owned state uniformly.
	if (owned_args.some((o) => o.kind !== "plain")) {
		header += `static void ${destroy_name}(void *_p) {\n`;
		header += `\tstruct ${struct_name} *a = (struct ${struct_name} *)_p;\n`;
		for (const o of owned_args) {
			if (o.kind === "string") {
				header += `\tfree(a->arg${o.index}.ptr);\n`;
			} else if (o.kind === "struct") {
				if (o.owns) header += `\t${o.struct_name}_destroy(a->arg${o.index});\n`;
				header += `\tfree(a->arg${o.index});\n`;
			}
		}
		header += `}\n`;
	}
	// Trampoline: signature is the closure ABI — the code receives the
	// closure itself, and the args struct rides in `env`. The pool worker
	// (or fiber scheduler) calls it; the trampoline calls the user function
	// and signals the future when done. The closure itself is disposed by
	// the future's last release (owner_args), not here.
	header += `static void ${tramp_name}(struct nomen_closure *_c) {\n`;
	header += `\tstruct ${struct_name} *a = (struct ${struct_name} *)_c->env;\n`;
	header += `\t__nomen_current_cancel_flag = a->cancel_flag;\n`;
	if (returns_value) {
		header += `\t${c_ret_type} _r = ${func_name}(`;
	} else {
		header += `\t${func_name}(`;
	}
	for (let i = 0; i < arg_c_types_with_owned.length; i++) {
		if (i > 0) header += ", ";
		header += `a->arg${i}`;
	}
	header += ");\n";
	if (returns_value) {
		header += `\t*(a->result_slot) = _r;\n`;
	}
	header += `\t__nomen_current_cancel_flag = NULL;\n`;
	header += `\t__nomen_future_complete(a->future);\n`;
	// The trampoline holds one future reference for the duration of the run —
	// release it only after signaling, so the future (and the result slot it
	// owns) is guaranteed alive while the result is written. The final
	// release disposes the task closure (env + descriptor).
	header += `\t__nomen_future_release(a->future);\n`;
	header += `}\n`;
	// Static descriptor template for this site: every construction copies it
	// into a heap descriptor (owned = 1) carrying the per-construction env —
	// and the env destructor when the env owns anything.
	const has_env_destroy = owned_args.some((o) => o.kind !== "plain");
	header += `static struct nomen_closure ${desc_name} = { (void *)${tramp_name}, NULL, 0, ${
		has_env_destroy ? `(void (*)(void *))${destroy_name}` : "NULL"
	} };\n`;
	status.headers += header;

	return { struct_name, desc_name, arg_c_types, func_name, owned_args };
}

/** One spawn argument's env-ownership classification (Phase 3d). */
export interface OwnedArg {
	index: number;
	kind: "string" | "struct" | "plain";
	struct_name?: string;
	owns?: boolean;
	string_fields?: string[];
}

/**
 * Build the `Thread(fn(args))` / `Fiber(fn(args))` construction expression:
 * a GCC statement expression that packs the args, allocates the machinery,
 * constructs the task closure, and yields the heap instance.
 */
export default function build_magic_ctor_node(node: FunctionCallNode, status: BuildStatus) {
	const kind = node.is_fiber_ctor ? "Fiber" : "Thread";
	const call = node.params[0] as FunctionCallNode;
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	// Emit pool infrastructure on first spawn (file scope, deduped).
	ensure_concurrency_runtime(status);

	if (node.is_func_value_ctor) {
		build_fn_value_ctor(node, status, id, kind);
		return;
	}

	const task_c = spawn_task_c_types(node.function_return_type, status);
	const { struct_name, desc_name, owned_args } = emit_spawn_task_body(call, status, id, task_c);
	const { returns_value, slot_c_type } = task_c;
	const mono_name = mono_type_name(kind, node.type?.type_args);

	// Statement expression: pack args, allocate slot/flag/future, build the
	// task closure, construct the instance.
	status.code += `({\n`;
	status.code += `\tstruct ${struct_name} *_args = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < call.params.length; i++) {
		const owned = owned_args.find((o) => o.index === i);
		if (owned?.kind === "string") {
			// The env owns a deep copy; the caller's own buffer is untouched.
			status.code += `\t_args->arg${i} = nomen_str_dup(`;
			build_node(call.params[i], status);
			status.code += ");\n";
		} else if (owned?.kind === "struct") {
			// The env owns a malloc'd copy of the struct's bytes with its
			// top-level string fields deep-copied; the env destructor
			// destroys + frees it. A struct PARAMETER donor is itself a
			// pointer, so dereference it.
			const st = owned.struct_name;
			status.code += `\t_args->arg${i} = ({ struct ${st} *_v = (struct ${st} *)malloc(sizeof(struct ${st})); *_v = `;
			build_node(call.params[i], status);
			status.code += `;`;
			for (const f of owned.string_fields ?? []) {
				status.code += ` { nomen_string _t = nomen_str_dup(_v->${f}); _v->${f} = _t; }`;
			}
			status.code += ` _v; });\n`;
		} else {
			status.code += `\t_args->arg${i} = `;
			build_node(call.params[i], status);
			status.code += ";\n";
		}
	}
	if (returns_value) {
		status.code += `\t${slot_c_type} *_result_ptr = (${slot_c_type} *)malloc(sizeof(${slot_c_type}));\n`;
		status.code += `\tmemset(_result_ptr, 0, sizeof(${slot_c_type}));\n`;
	} else {
		// A void task's slot still exists (16 bytes — Task.result may read
		// the pair) but is never written.
		status.code += `\tunsigned long long *_result_ptr = (unsigned long long *)malloc(16);\n`;
		status.code += `\tmemset(_result_ptr, 0, 16);\n`;
	}
	status.code += `\t_args->result_slot = _result_ptr;\n`;
	status.code += `\tunsigned long long *_cancel_ptr = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	status.code += `\t*_cancel_ptr = 0;\n`;
	status.code += `\t_args->cancel_flag = _cancel_ptr;\n`;
	status.code += `\tstruct nomen_future *_future = (struct nomen_future *)malloc(sizeof(struct nomen_future));\n`;
	status.code += `\tpthread_mutex_init(&_future->mu, NULL);\n`;
	status.code += `\tpthread_cond_init(&_future->cv, NULL);\n`;
	status.code += `\t_future->done = 0;\n`;
	status.code += `\t_future->cancel_flag = _cancel_ptr;\n`;
	status.code += `\t_future->result_slot = _result_ptr;\n`;
	status.code += `\t_future->fiber_waiters = NULL;\n`;
	status.code += `\t_future->owning_fiber = NULL;\n`;
	// One reference: this instance. The launch (or #destroy) releases it.
	status.code += `\t_future->refs = 1;\n`;
	status.code += `\t_args->future = _future;\n`;
	status.code += `\tstruct nomen_closure *_closure = (struct nomen_closure *)malloc(sizeof(struct nomen_closure));\n`;
	status.code += `\t*_closure = ${desc_name};\n`;
	status.code += `\t_closure->env = _args;\n`;
	status.code += `\t_closure->owned = 1;\n`;
	status.code += `\t_future->owner_args = _closure;\n`;
	// The instance: zeroed first (a class's trait-table slot stays NULL
	// unless trait-dispatched — the same posture as the spawn-built Task),
	// then the handles.
	status.code += `\tstruct ${mono_name} *_self = (struct ${mono_name} *)malloc(sizeof(struct ${mono_name}));\n`;
	status.code += `\tmemset(_self, 0, sizeof(struct ${mono_name}));\n`;
	status.code += `\t_self->task = (unsigned long long)_closure;\n`;
	status.code += `\t_self->result_slot = (unsigned long long)_result_ptr;\n`;
	status.code += `\t_self->cancel_flag = (unsigned long long)_cancel_ptr;\n`;
	status.code += `\t_self->future = (unsigned long long)_future;\n`;
	status.code += `\t_self->started = 0;\n`;
	status.code += `\t_self;\n`;
	status.code += `})\n`;
}

/**
 * The Phase 3c function-value construction (`Thread(() => work(n))` /
 * `Thread(job)` with a zero-argument func-typed local): the task closure is
 * an ADAPTER over the given closure. The adapter env carries the user
 * closure pointer plus the machinery; the trampoline calls the user closure
 * through the descriptor ABI (`code(env)` — a zero-arg function value takes
 * no further arguments), stores the result, disposes the user closure (the
 * task owns it — for a literal it was fresh, for a local the construction
 * moved it), and completes the future. A `string` result is strdup'd into
 * the slot: a capturing lambda's returned string aliases its env, which the
 * dispose would otherwise free under the Task's feet. For class/trait/
 * value-struct results the user closure is NOT disposed — a returned
 * instance may alias the env's captures, and the codebase's posture is
 * leak-never-dangle.
 */
function build_fn_value_ctor(
	node: FunctionCallNode,
	status: BuildStatus,
	id: number,
	kind: "Thread" | "Fiber",
) {
	const fn_value = node.params[0];
	const task_c = spawn_task_c_types(node.function_return_type, status);
	const { returns_value, c_ret_type, slot_c_type } = task_c;
	const struct_name = `__nomen_spawn_${id}_args`;
	const tramp_name = `__nomen_spawn_${id}_trampoline`;
	const desc_name = `__nomen_spawn_${id}_descriptor`;
	const mono_name = mono_type_name(kind, node.type?.type_args);
	// A `string` result needs ownership care: a capturing lambda's returned
	// string may ALIAS its env (returning a captured string), which the
	// adapter's dispose would free under the Task's feet. For a LITERAL the
	// capture set is known: compare the result against each captured string
	// — an alias is duplicated into the slot (the env keeps its original,
	// disposed with the closure); anything else is transferred as-is (the
	// Task machinery owns the slot's buffer). For a moved local or a named
	// function the closure is opaque: duplicate and LEAK the original
	// (leak-never-dangle; bounded at one per run).
	const dup_result = returns_value && node.function_return_type?.name === "string";
	const lambda = fn_value.node_type === "func" ? (fn_value as FunctionNode) : undefined;
	const string_caps = lambda
		? (lambda.captures ?? []).filter(
				(c) => c.type.name === "string" && !c.type.is_view && !c.type.is_array,
			)
		: [];
	let result_store: string;
	if (!dup_result) {
		result_store = `*(a->result_slot) = _r;`;
	} else if (lambda && string_caps.length === 0) {
		// A literal with no captured strings: the result cannot alias the
		// env — transfer it.
		result_store = `*(a->result_slot) = _r;`;
	} else if (lambda) {
		const env_name = emit_closure_env_type(lambda, status);
		const checks = string_caps
			.map(
				(c) =>
					`_r.ptr == (char *)((struct ${env_name} *)a->fn->env)->${c_function_name(c.name)}.ptr`,
			)
			.join(" || ");
		result_store = `*(a->result_slot) = (${checks}) ? nomen_str_dup(_r) : _r;`;
	} else {
		result_store = `*(a->result_slot) = nomen_str_dup(_r);`;
	}

	// The adapter env: the user closure + the machinery fields the
	// trampoline and the Task handle share.
	let header = `struct ${struct_name} {\n`;
	header += `\tstruct nomen_closure *fn;\n`;
	header += `\t${slot_c_type} *result_slot;\n`;
	header += `\tunsigned long long *cancel_flag;\n`;
	header += `\tstruct nomen_future *future;\n`;
	header += `};\n`;
	header += `static void ${tramp_name}(struct nomen_closure *_c) {\n`;
	header += `\tstruct ${struct_name} *a = (struct ${struct_name} *)_c->env;\n`;
	header += `\t__nomen_current_cancel_flag = a->cancel_flag;\n`;
	if (returns_value) {
		header += `\t${c_ret_type} _r = ((${c_ret_type} (*)(void *))a->fn->code)(a->fn->env);\n`;
		header += `\t${result_store}\n`;
	} else {
		header += `\t((void (*)(void *))a->fn->code)(a->fn->env);\n`;
	}
	header += `\t__nomen_current_cancel_flag = NULL;\n`;
	if (
		!returns_value ||
		dup_result ||
		(!is_class_or_trait_ret(node, status) && !is_struct_ret(node, status))
	) {
		header += `\t__nomen_closure_dispose(a->fn);\n`;
	}
	header += `\t__nomen_future_complete(a->future);\n`;
	header += `\t__nomen_future_release(a->future);\n`;
	header += `}\n`;
	header += `static struct nomen_closure ${desc_name} = { (void *)${tramp_name}, NULL, 0, NULL };\n`;
	status.headers += header;

	// Statement expression: build the function value, wrap it in the
	// adapter closure, construct the instance.
	status.code += `({\n`;
	status.code += `\tstruct nomen_closure *_user_fn = `;
	const resolved_fn = (
		fn_value as unknown as { resolved_function?: import("../nodes/FunctionNode.ts").default }
	).resolved_function;
	if (fn_value.node_type === "func") {
		// A lambda literal: the definition + descriptor (heap when
		// capturing, static when capture-free).
		build_node(fn_value, status);
	} else if (resolved_fn) {
		// A named function / capture-free declaration lambda: its
		// thunk-backed static descriptor (nothing to own, nothing to move).
		status.code += materialize_func_value(resolved_fn, status);
	} else {
		// A func-typed local: the stored descriptor, MOVED into the task.
		build_node(fn_value, status);
	}
	status.code += `;\n`;
	// A func-typed LOCAL was moved into the task: its scope-exit
	// free-if-owned arm must skip it (the adapter owns the closure now).
	if (fn_value.node_type === "value" && (fn_value as unknown as { is_moved?: boolean }).is_moved) {
		const name = (fn_value as unknown as { value: string }).value;
		if (!status.moved) status.moved = new Set();
		status.moved.add(name);
	}
	status.code += `\t${slot_c_type} *_result_ptr = (${slot_c_type} *)${returns_value ? `malloc(sizeof(${slot_c_type}))` : "malloc(16)"};\n`;
	status.code += `\tmemset(_result_ptr, 0, ${returns_value ? `sizeof(${slot_c_type})` : "16"});\n`;
	status.code += `\tunsigned long long *_cancel_ptr = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	status.code += `\t*_cancel_ptr = 0;\n`;
	status.code += `\tstruct nomen_future *_future = (struct nomen_future *)malloc(sizeof(struct nomen_future));\n`;
	status.code += `\tpthread_mutex_init(&_future->mu, NULL);\n`;
	status.code += `\tpthread_cond_init(&_future->cv, NULL);\n`;
	status.code += `\t_future->done = 0;\n`;
	status.code += `\t_future->cancel_flag = _cancel_ptr;\n`;
	status.code += `\t_future->result_slot = _result_ptr;\n`;
	status.code += `\t_future->fiber_waiters = NULL;\n`;
	status.code += `\t_future->owning_fiber = NULL;\n`;
	status.code += `\t_future->refs = 1;\n`;
	status.code += `\tstruct nomen_closure *_closure = (struct nomen_closure *)malloc(sizeof(struct nomen_closure));\n`;
	status.code += `\t*_closure = ${desc_name};\n`;
	status.code += `\tstruct ${struct_name} *_args = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	status.code += `\t_args->fn = _user_fn;\n`;
	status.code += `\t_args->result_slot = _result_ptr;\n`;
	status.code += `\t_args->cancel_flag = _cancel_ptr;\n`;
	status.code += `\t_args->future = _future;\n`;
	status.code += `\t_closure->env = _args;\n`;
	status.code += `\t_closure->owned = 1;\n`;
	status.code += `\t_future->owner_args = _closure;\n`;
	status.code += `\tstruct ${mono_name} *_self = (struct ${mono_name} *)malloc(sizeof(struct ${mono_name}));\n`;
	status.code += `\tmemset(_self, 0, sizeof(struct ${mono_name}));\n`;
	status.code += `\t_self->task = (unsigned long long)_closure;\n`;
	status.code += `\t_self->result_slot = (unsigned long long)_result_ptr;\n`;
	status.code += `\t_self->cancel_flag = (unsigned long long)_cancel_ptr;\n`;
	status.code += `\t_self->future = (unsigned long long)_future;\n`;
	status.code += `\t_self->started = 0;\n`;
	status.code += `\t_self;\n`;
	status.code += `})\n`;
}

/** Whether the wrapped function value returns a CLASS or TRAIT (pointer
 *  result that may alias the closure env's captures). */
function is_class_or_trait_ret(node: FunctionCallNode, status: BuildStatus): boolean {
	const name = node.function_return_type?.name;
	if (!name) return false;
	return (
		!!status.structs.find((s) => s.name === name && s.is_class) ||
		!!status.traits.find((t) => t.name === name)
	);
}

/** Whether the wrapped function value returns a value STRUCT (a byte result
 *  whose heap fields may alias the closure env's captures). */
function is_struct_ret(node: FunctionCallNode, status: BuildStatus): boolean {
	const name = node.function_return_type?.name;
	if (!name) return false;
	return !!status.structs.find((s) => s.name === name && !s.is_class && !s.is_simple_type);
}
