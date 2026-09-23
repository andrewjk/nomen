import { spawn_ctor_class_name, spawn_instance_info } from "../build_c/build_magic_ctor.ts";
import type BuildStatus from "../build_c/BuildStatus.ts";
import c_function_name from "../build_c/utils/c_function_name.ts";
import c_type from "../build_c/utils/c_type.ts";
import { c_env_field_type, emit_closure_env_type } from "../build_c/utils/closure_env.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import emission_label from "../build_common/emission_label.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import build_node from "./build_node.ts";
import { ensure_concurrency_runtime_a64, spawn_arg_is_string } from "./build_spawn_node.ts";
import { emit_descriptor_address, materialize_func_value_a64 } from "./utils/closure_a64.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";

/**
 * The `#spawn` construction (the deferred-call special form — the library
 * `Thread(fn(args))` / `Fiber(fn(args))`, or any class declaring its own
 * `#spawn` hook; docs/ASYNC.md, "The construction special form"),
 * aarch64 backend: the per-site
 * trampoline and a constructor helper are emitted as C in the companion
 * file; the assembly stages the wrapped call's arguments and calls the
 * helper, which packs the env, allocates the future machinery, builds the
 * task closure, constructs the mono instance, and returns it.
 */
export default function build_magic_ctor_node(node: FunctionCallNode, status: BuildStatus) {
	const kind = spawn_ctor_class_name(node);
	const info = spawn_instance_info(node, status);
	const call = node.params[0] as FunctionCallNode;
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	ensure_concurrency_runtime_a64(status);

	// Phase 3c: the zero-argument function-value form — the task closure is
	// an adapter over the given closure (see the C backend's build_fn_value_ctor).
	if (node.is_func_value_ctor) {
		build_fn_value_ctor_a64(node, status, id, kind, info);
		return;
	}

	const func_name = c_function_name(emission_label(call.resolved_function ?? call));

	const helper_name = `nomen_spawn_${id}_ctor`;
	const tramp_name = `__nomen_spawn_${id}_trampoline`;
	const desc_name = `__nomen_spawn_${id}_descriptor`;
	const struct_name = `__nomen_spawn_${id}_args`;

	const nursery_id = status.nursery_stack?.at(-1);
	const nursery_off =
		nursery_id !== undefined ? status.nursery_offsets?.get(nursery_id) : undefined;
	const capture = nursery_capture_a64(status, kind);

	// Arg C types (fat strings ride the 16-byte nomen_string pair).
	const arg_c_types: string[] = [];
	const fat_string_args: boolean[] = [];
	for (let i = 0; i < call.params.length; i++) {
		const arg_type = type_from_value_node(call.params[i]);
		const mono_name = mono_type_name(arg_type);
		const is_class = !!status.structs.find((s) => s.name === mono_name && s.is_class);
		const is_trait = !!status.traits.find((t) => t.name === mono_name);
		arg_c_types.push(is_class || is_trait ? `struct ${mono_name} *` : `${c_type(mono_name)}`);
		fat_string_args.push(spawn_arg_is_string(call.params[i]));
	}
	// Phase 3d: the env OWNS its fat-string args — duplicated at pack, freed
	// by the env destructor (a raw pair copy would alias the caller's
	// buffer). Owning value-struct args are not covered here: the aarch64
	// arg staging passes one word per non-string arg, so a by-value struct
	// arg never reaches the env intact (pre-existing limitation).
	const has_env_destroy = fat_string_args.some(Boolean);

	const return_type_name = node.function_return_type?.name;
	const returns_value = !!(
		return_type_name &&
		return_type_name !== "void" &&
		return_type_name !== "?"
	);
	const is_class_ret = returns_value
		? !!status.structs.find((s) => s.name === return_type_name && s.is_class)
		: false;
	const is_trait_ret = returns_value
		? !!status.traits.find((t) => t.name === return_type_name)
		: false;
	const c_ret_type = !returns_value
		? "void"
		: is_class_ret || is_trait_ret
			? `struct ${return_type_name} *`
			: c_type(return_type_name!);
	const slot_c_type = returns_value ? c_ret_type : "unsigned long long";
	const mono_name = info.mono_name;

	// --- Companion C: trampoline + descriptor + constructor helper ---
	let c = `// --- spawn construction site ${id} (${kind}) ---\n`;
	// The generalized Awaitable instance is trait-dispatchable: the helper
	// installs the class's traits table (extern — the table lives in the
	// emitted data segment; Thread/Fiber keep their vtable-less emission).
	if (info.traits) {
		c += `extern void *${mono_name}_traits[];\n`;
	}
	if (has_env_destroy) {
		// The companion cannot see main.h, where build.ts emits
		// nomen_str_dup — carry a guarded local definition.
		c += `#ifndef NOMEN_STR_DUP\n#define NOMEN_STR_DUP\nstatic nomen_string nomen_str_dup(nomen_string s) {\n\tchar *p = (char *)malloc(s.len + 1);\n\tmemcpy(p, s.ptr, s.len);\n\tp[s.len] = 0;\n\tnomen_string r = { p, s.len };\n\treturn r;\n}\n#endif\n`;
	}
	c += `${c_ret_type} ${func_name}(`;
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) c += ", ";
		c += `${arg_c_types[i]}`;
	}
	c += `);\n`;
	c += `struct ${struct_name} {\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		c += `\t${arg_c_types[i]} arg${i};\n`;
	}
	c += `\t${slot_c_type} *result_slot;\n`;
	c += `\tunsigned long long *cancel_flag;\n`;
	c += `\tstruct nomen_future *future;\n`;
	c += `};\n`;
	// The env destructor (Phase 3d): frees each duplicated string.
	if (has_env_destroy) {
		c += `static void __nomen_spawn_${id}_env_destroy(void *_p) {\n`;
		c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)_p;\n`;
		for (let i = 0; i < arg_c_types.length; i++) {
			if (fat_string_args[i]) c += `\tfree(a->arg${i}.ptr);\n`;
		}
		c += `}\n`;
	}
	// Trampoline: closure ABI — the code receives the closure itself; the
	// packed args ride in env. Disposal happens at the future's last release.
	c += `static void ${tramp_name}(struct nomen_closure *_c) {\n`;
	c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)_c->env;\n`;
	c += `\t__nomen_current_cancel_flag = a->cancel_flag;\n`;
	if (returns_value) {
		c += `\t${c_ret_type} _r = ${func_name}(`;
	} else {
		c += `\t${func_name}(`;
	}
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) c += ", ";
		c += `a->arg${i}`;
	}
	c += `);\n`;
	if (returns_value) {
		c += `\t*(a->result_slot) = _r;\n`;
	}
	c += `\t__nomen_current_cancel_flag = NULL;\n`;
	c += `\t__nomen_future_complete(a->future);\n`;
	c += `\t__nomen_future_release(a->future);\n`;
	c += `}\n`;
	c += `static struct nomen_closure ${desc_name} = { (void *)${tramp_name}, NULL, 0, ${
		has_env_destroy ? `(void (*)(void *))__nomen_spawn_${id}_env_destroy` : "NULL"
	} };\n`;
	// Constructor helper: packs env + machinery + closure into a heap
	// instance of the mono spawn class. Returns the instance pointer.
	c += `void *${helper_name}(`;
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) c += ", ";
		c += `${arg_c_types[i]} arg${i}`;
	}
	// capture.helper_params carries NO leading comma (a zero-argument
	// wrapped call has an empty leading list — emitting it verbatim after
	// `(` produced `ctor(, unsigned long long …)` and clang rejected it).
	if (capture) {
		if (arg_c_types.length > 0) c += ", ";
		c += capture.helper_params;
	}
	c += `) {\n`;
	c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		// The env owns a deep copy of each string arg (Phase 3d).
		c += `\ta->arg${i} = ${fat_string_args[i] ? "nomen_str_dup(arg" + i + ")" : `arg${i}`};\n`;
	}
	c += `\ta->result_slot = (${slot_c_type} *)${returns_value ? `malloc(sizeof(${slot_c_type}))` : "malloc(16)"};\n`;
	c += `\tmemset(a->result_slot, 0, ${returns_value ? `sizeof(${slot_c_type})` : "16"});\n`;
	c += `\ta->cancel_flag = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	c += `\t*(a->cancel_flag) = 0;\n`;
	c += `\tstruct nomen_future *f = (struct nomen_future *)malloc(sizeof(struct nomen_future));\n`;
	c += `\tpthread_mutex_init(&f->mu, NULL);\n`;
	c += `\tpthread_cond_init(&f->cv, NULL);\n`;
	c += `\tf->done = 0;\n`;
	c += `\tf->refs = 1;\n`; // the instance's own reference
	c += `\tf->cancel_flag = a->cancel_flag;\n`;
	c += `\tf->result_slot = a->result_slot;\n`;
	c += `\tf->fiber_waiters = NULL;\n`;
	c += `\tf->owning_fiber = 0;\n`;
	c += `\ta->future = f;\n`;
	c += `\tstruct nomen_closure *cl = (struct nomen_closure *)malloc(sizeof(struct nomen_closure));\n`;
	c += `\t*cl = ${desc_name};\n`;
	c += `\tcl->env = a;\n`;
	c += `\tcl->owned = 1;\n`;
	c += `\tf->owner_args = cl;\n`;
	c += `\tstruct ${mono_name} *self = (struct ${mono_name} *)malloc(sizeof(struct ${mono_name}));\n`;
	c += `\tmemset(self, 0, sizeof(struct ${mono_name}));\n`;
	if (info.traits) c += `\tself->_vt = (void **)${mono_name}_traits;\n`;
	c += `\tself->task = (unsigned long long)cl;\n`;
	c += `\tself->result_slot = (unsigned long long)a->result_slot;\n`;
	c += `\tself->cancel_flag = (unsigned long long)a->cancel_flag;\n`;
	c += `\tself->future = (unsigned long long)f;\n`;
	if (info.has_started) c += `\tself->started = 0;\n`;
	if (capture) c += capture.field_stores.join("");
	c += `\treturn self;\n`;
	c += `}\n`;

	if (!status.file_scope_c) status.file_scope_c = "";
	status.file_scope_c += c;

	// --- Assembly: build arg registers and call the constructor helper ---
	emit_asm(status, `// spawn construction site ${id} (${kind})\n`);
	const arg_slot: number[] = [];
	let total_arg_slots = 0;
	for (let i = 0; i < call.params.length; i++) {
		arg_slot.push(total_arg_slots);
		total_arg_slots += fat_string_args[i] ? 2 : 1;
	}
	// The capture addresses ride as trailing helper arguments: the wrapped
	// call's args fill the leading slots, the three frame addresses the last
	// three (see nursery_capture_a64).
	const capture_base_slot = total_arg_slots;
	if (capture) total_arg_slots += capture.arg_count;

	if (total_arg_slots === 0) {
		emit_asm(status, `bl _${helper_name}\n`);
	} else {
		const args_base = allocate_stack_space(status, total_arg_slots * 8, 16);
		for (let i = 0; i < call.params.length; i++) {
			emit_asm(status, `// Build arg${i}\n`);
			build_node(call.params[i], status);
			ensure_newline(status);
			emit_asm(status, `str x0, [x29, #${args_base + arg_slot[i] * 8}]\n`);
			if (fat_string_args[i]) {
				emit_asm(status, `str x1, [x29, #${args_base + (arg_slot[i] + 1) * 8}]\n`);
			}
		}
		// The nursery capture slots hold FRAME ADDRESSES of the enclosing
		// async block's tracking slots (nursery_offsets) — built after the
		// wrapped-call args (only scratch x9 is touched).
		if (capture && nursery_off) {
			const addrs = [nursery_off.futures_off, nursery_off.count_off, nursery_off.cap_off];
			for (let k = 0; k < addrs.length; k++) {
				emit_asm(status, `add x9, x29, #${addrs[k]}\n`);
				emit_asm(status, `str x9, [x29, #${args_base + (capture_base_slot + k) * 8}]\n`);
			}
		}
		const NUM_REG_ARGS = 8;
		const overflow_count = Math.max(0, total_arg_slots - NUM_REG_ARGS);
		if (overflow_count > 0) {
			const outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
			emit_asm(status, `sub sp, sp, #${outgoing_size}\n`);
			for (let k = 0; k < overflow_count; k++) {
				emit_asm(status, `ldr x9, [x29, #${args_base + (NUM_REG_ARGS + k) * 8}]\n`);
				emit_asm(status, `str x9, [sp, #${k * 8}]\n`);
			}
		}
		for (let s = 0; s < Math.min(total_arg_slots, NUM_REG_ARGS); s++) {
			emit_asm(status, `ldr x${s}, [x29, #${args_base + s * 8}]\n`);
		}
		emit_asm(status, `bl _${helper_name}\n`);
		if (overflow_count > 0) {
			const outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
			emit_asm(status, `add sp, sp, #${outgoing_size}\n`);
		}
	}
	// x0 = the Thread/Fiber instance pointer.
}

/**
 * The Phase 3c function-value construction, aarch64 backend (see the C
 * backend's build_fn_value_ctor): the adapter env/trampoline/descriptor and
 * a constructor helper are emitted as companion C; the assembly builds the
 * function value (a lambda literal's descriptor or a func-typed local's
 * stored descriptor) into x0 and calls the helper, which wraps it and
 * returns the instance.
 */
function build_fn_value_ctor_a64(
	node: FunctionCallNode,
	status: BuildStatus,
	id: number,
	kind: string,
	info: { mono_name: string; has_started: boolean; traits: boolean },
) {
	const fn_value = node.params[0];
	const helper_name = `nomen_fnval_${id}_ctor`;
	const struct_name = `__nomen_spawn_${id}_args`;
	const tramp_name = `__nomen_spawn_${id}_trampoline`;
	const desc_name = `__nomen_spawn_${id}_descriptor`;
	const mono_name = info.mono_name;

	const return_type_name = node.function_return_type?.name;
	const returns_value = !!(
		return_type_name &&
		return_type_name !== "void" &&
		return_type_name !== "?"
	);
	const is_class_ret = returns_value
		? !!status.structs.find((s) => s.name === return_type_name && s.is_class)
		: false;
	const is_trait_ret = returns_value
		? !!status.traits.find((t) => t.name === return_type_name)
		: false;
	const is_struct_ret = returns_value
		? !!status.structs.find((s) => s.name === return_type_name && !s.is_simple_type && !s.is_class)
		: false;
	const c_ret_type = !returns_value
		? "void"
		: is_class_ret || is_trait_ret
			? `struct ${return_type_name} *`
			: c_type(return_type_name!);
	const slot_c_type = returns_value ? c_ret_type : "unsigned long long";
	// A `string` result needs ownership care (see the C backend's
	// build_fn_value_ctor): alias vs fresh is decided per capture for a
	// LITERAL; opaque closures duplicate and leak the original
	// (leak-never-dangle).
	const dup_result = returns_value && return_type_name === "string";
	const lambda = fn_value.node_type === "func" ? (fn_value as FunctionNode) : undefined;
	const string_caps = lambda
		? (lambda.captures ?? []).filter(
				(c: { type: { name: string; is_view?: boolean; is_array?: boolean } }) =>
					c.type.name === "string" && !c.type.is_view && !c.type.is_array,
			)
		: [];
	let result_store: string;
	let env_def = "";
	if (!dup_result) {
		result_store = `*(a->result_slot) = _r;`;
	} else if (lambda && string_caps.length === 0) {
		result_store = `*(a->result_slot) = _r;`;
	} else if (lambda) {
		const env_name = emit_closure_env_type(lambda, status);
		const checks = string_caps
			.map(
				(c: { name: string }) =>
					`_r.ptr == (char *)((struct ${env_name} *)a->fn->env)->${c_function_name(c.name)}.ptr`,
			)
			.join(" || ");
		result_store = `*(a->result_slot) = (${checks}) ? nomen_str_dup(_r) : _r;`;
		// The companion cannot see the env typedef (it lives in headers) —
		// carry an identical definition (same field order/layout).
		env_def = `struct ${env_name} {\n`;
		for (const cap of lambda.captures ?? []) {
			env_def += `\t${c_env_field_type(cap.type, status)} ${c_function_name(cap.name)};\n`;
		}
		env_def += `};\n`;
	} else {
		result_store = `*(a->result_slot) = nomen_str_dup(_r);`;
	}
	const dispose_fn =
		!returns_value || dup_result || (!is_class_ret && !is_trait_ret && !is_struct_ret);

	let c = `// --- function-value spawn construction site ${id} (${kind}) ---\n`;
	// Trait vtable for the generalized Awaitable flavor (see the call form).
	if (info.traits) {
		c += `extern void *${mono_name}_traits[];\n`;
	}
	if (env_def) c += env_def;
	if (dup_result) {
		// The companion does not include main.h, where build.ts emits
		// nomen_str_dup — carry a guarded local definition.
		c += `#ifndef NOMEN_STR_DUP\n#define NOMEN_STR_DUP\nstatic nomen_string nomen_str_dup(nomen_string s) {\n\tchar *p = (char *)malloc(s.len + 1);\n\tmemcpy(p, s.ptr, s.len);\n\tp[s.len] = 0;\n\tnomen_string r = { p, s.len };\n\treturn r;\n}\n#endif\n`;
	}
	c += `struct ${struct_name} {\n`;
	c += `\tstruct nomen_closure *fn;\n`;
	c += `\t${slot_c_type} *result_slot;\n`;
	c += `\tunsigned long long *cancel_flag;\n`;
	c += `\tstruct nomen_future *future;\n`;
	c += `};\n`;
	c += `static void ${tramp_name}(struct nomen_closure *_c) {\n`;
	c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)_c->env;\n`;
	c += `\t__nomen_current_cancel_flag = a->cancel_flag;\n`;
	if (returns_value) {
		c += `\t${c_ret_type} _r = ((${c_ret_type} (*)(void *))a->fn->code)(a->fn->env);\n`;
		c += `\t${result_store}\n`;
	} else {
		c += `\t((void (*)(void *))a->fn->code)(a->fn->env);\n`;
	}
	c += `\t__nomen_current_cancel_flag = NULL;\n`;
	if (dispose_fn) c += `\t__nomen_closure_dispose(a->fn);\n`;
	c += `\t__nomen_future_complete(a->future);\n`;
	c += `\t__nomen_future_release(a->future);\n`;
	c += `}\n`;
	c += `static struct nomen_closure ${desc_name} = { (void *)${tramp_name}, NULL, 0, NULL };\n`;
	const fnval_capture = nursery_capture_a64(status, kind);
	c += `void *${helper_name}(struct nomen_closure *fn${fnval_capture ? `, ${fnval_capture.helper_params}` : ""}) {\n`;
	c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	c += `\ta->fn = fn;\n`;
	c += `\ta->result_slot = (${slot_c_type} *)${returns_value ? `malloc(sizeof(${slot_c_type}))` : "malloc(16)"};\n`;
	c += `\tmemset(a->result_slot, 0, ${returns_value ? `sizeof(${slot_c_type})` : "16"});\n`;
	c += `\ta->cancel_flag = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	c += `\t*(a->cancel_flag) = 0;\n`;
	c += `\tstruct nomen_future *f = (struct nomen_future *)malloc(sizeof(struct nomen_future));\n`;
	c += `\tpthread_mutex_init(&f->mu, NULL);\n`;
	c += `\tpthread_cond_init(&f->cv, NULL);\n`;
	c += `\tf->done = 0;\n`;
	c += `\tf->refs = 1;\n`;
	c += `\tf->cancel_flag = a->cancel_flag;\n`;
	c += `\tf->result_slot = a->result_slot;\n`;
	c += `\tf->fiber_waiters = NULL;\n`;
	c += `\tf->owning_fiber = 0;\n`;
	c += `\ta->future = f;\n`;
	c += `\tstruct nomen_closure *cl = (struct nomen_closure *)malloc(sizeof(struct nomen_closure));\n`;
	c += `\t*cl = ${desc_name};\n`;
	c += `\tcl->env = a;\n`;
	c += `\tcl->owned = 1;\n`;
	c += `\tf->owner_args = cl;\n`;
	c += `\tstruct ${mono_name} *self = (struct ${mono_name} *)malloc(sizeof(struct ${mono_name}));\n`;
	c += `\tmemset(self, 0, sizeof(struct ${mono_name}));\n`;
	if (info.traits) c += `\tself->_vt = (void **)${mono_name}_traits;\n`;
	c += `\tself->task = (unsigned long long)cl;\n`;
	c += `\tself->result_slot = (unsigned long long)a->result_slot;\n`;
	c += `\tself->cancel_flag = (unsigned long long)a->cancel_flag;\n`;
	c += `\tself->future = (unsigned long long)f;\n`;
	if (info.has_started) c += `\tself->started = 0;\n`;
	if (fnval_capture) c += fnval_capture.field_stores.join("");
	c += `\treturn self;\n`;
	c += `}\n`;

	if (!status.file_scope_c) status.file_scope_c = "";
	status.file_scope_c += c;

	// --- Assembly: the function value into x0, call the helper ---
	emit_asm(status, `// function-value spawn construction site ${id} (${kind})\n`);
	const resolved_fn = (fn_value as unknown as { resolved_function?: FunctionNode })
		.resolved_function;
	if (fn_value.node_type === "func") {
		// A lambda literal: the definition + descriptor.
		build_node(fn_value, status);
	} else if (resolved_fn) {
		// A named function / capture-free declaration lambda: its
		// thunk-backed static descriptor.
		const desc = materialize_func_value_a64(resolved_fn, status);
		emit_descriptor_address(status, "x0", desc);
	} else {
		// A func-typed local: the stored descriptor, MOVED into the task.
		build_node(fn_value, status);
	}
	ensure_newline(status);
	// A func-typed LOCAL was moved into the task: its scope-exit
	// free-if-owned arm must skip it.
	if (fn_value.node_type === "value" && (fn_value as unknown as { is_moved?: boolean }).is_moved) {
		const name = (fn_value as unknown as { value: string }).value;
		if (!status.moved) status.moved = new Set();
		status.moved.add(name);
	}
	// Nursery capture addresses ride as trailing helper args (x1-x3; the
	// user closure occupies x0).
	if (fnval_capture) {
		const fnval_nursery_id = status.nursery_stack?.at(-1);
		const fnval_off =
			fnval_nursery_id !== undefined ? status.nursery_offsets?.get(fnval_nursery_id) : undefined;
		if (fnval_off) {
			const fnval_park = allocate_stack_space(status, 8, 8);
			emit_asm(status, `str x0, [x29, #${fnval_park}]\n`);
			emit_asm(status, `add x1, x29, #${fnval_off.futures_off}\n`);
			emit_asm(status, `add x2, x29, #${fnval_off.count_off}\n`);
			emit_asm(status, `add x3, x29, #${fnval_off.cap_off}\n`);
			emit_asm(status, `ldr x0, [x29, #${fnval_park}]\n`);
		}
	}
	emit_asm(status, `bl _${helper_name}\n`);
	// x0 = the Thread/Fiber instance pointer.
}

/**
 * LEXICAL NURSERY CAPTURE (ASYNC.md), aarch64 backend. The
 * construction helper is companion C and cannot address the enclosing async
 * block's frame, so the assembly passes the three tracking-slot addresses as
 * trailing helper arguments and the helper stores them into the instance's
 * capture fields — the lexical-at-construction counterpart of the C
 * backend's emit_nursery_capture_c. Applies to Thread/Fiber only (they
 * carry the capture fields).
 */
function nursery_capture_a64(
	status: BuildStatus,
	kind: string,
): { helper_params: string; field_stores: string[]; arg_count: number } | undefined {
	const nursery_id = status.nursery_stack?.at(-1);
	if (nursery_id === undefined || (kind !== "Thread" && kind !== "Fiber")) return undefined;
	return {
		// No leading comma — the consumers join this onto their existing
		// parameter list (which may be EMPTY: a zero-argument wrapped call).
		helper_params:
			"unsigned long long nursery_futures, unsigned long long nursery_count, unsigned long long nursery_cap",
		field_stores: [
			`\tself->nursery_futures = nursery_futures;\n`,
			`\tself->nursery_count = nursery_count;\n`,
			`\tself->nursery_cap = nursery_cap;\n`,
		],
		arg_count: 3,
	};
}
