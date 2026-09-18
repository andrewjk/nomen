import type BuildStatus from "../build_c/BuildStatus.ts";
import c_function_name from "../build_c/utils/c_function_name.ts";
import c_type from "../build_c/utils/c_type.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import emission_label from "../build_common/emission_label.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import build_node from "./build_node.ts";
import { ensure_concurrency_runtime_a64, spawn_arg_is_string } from "./build_spawn_node.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";

/**
 * The compiler-special `Thread(fn(args))` / `Fiber(fn(args))` construction
 * (docs/CLOSURE_PLAN.md Phase 3b), aarch64 backend: the per-site trampoline
 * and a constructor helper are emitted as C in the companion file; the
 * assembly stages the wrapped call's arguments and calls the helper, which
 * packs the env, allocates the future machinery, builds the task closure,
 * constructs the mono Thread/Fiber instance, and returns it.
 */
export default function build_magic_ctor_node(node: FunctionCallNode, status: BuildStatus) {
	const kind = node.is_fiber_ctor ? "Fiber" : "Thread";
	const call = node.params[0] as FunctionCallNode;
	const func_name = c_function_name(emission_label(call.resolved_function ?? call));
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	ensure_concurrency_runtime_a64(status);

	const helper_name = `nomen_spawn_${id}_ctor`;
	const tramp_name = `__nomen_spawn_${id}_trampoline`;
	const desc_name = `__nomen_spawn_${id}_descriptor`;
	const struct_name = `__nomen_spawn_${id}_args`;

	// Arg C types (fat strings ride the 16-byte nomen_string pair).
	const arg_c_types: string[] = [];
	for (let i = 0; i < call.params.length; i++) {
		const arg_type = type_from_value_node(call.params[i]);
		const mono_name = mono_type_name(arg_type);
		const is_class = !!status.structs.find((s) => s.name === mono_name && s.is_class);
		const is_trait = !!status.traits.find((t) => t.name === mono_name);
		arg_c_types.push(is_class || is_trait ? `struct ${mono_name} *` : `${c_type(mono_name)}`);
	}

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
	const mono_name = mono_type_name(kind, node.type?.type_args);

	// --- Companion C: trampoline + descriptor + constructor helper ---
	let c = `// --- spawn construction site ${id} (${kind}) ---\n`;
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
	c += `static struct nomen_closure ${desc_name} = { (void *)${tramp_name}, NULL, 0, NULL };\n`;
	// Constructor helper: packs env + machinery + closure into a heap
	// instance of the mono spawn class. Returns the instance pointer.
	c += `void *${helper_name}(`;
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) c += ", ";
		c += `${arg_c_types[i]} arg${i}`;
	}
	c += `) {\n`;
	c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		c += `\ta->arg${i} = arg${i};\n`;
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
	c += `\tself->task = (unsigned long long)cl;\n`;
	c += `\tself->result_slot = (unsigned long long)a->result_slot;\n`;
	c += `\tself->cancel_flag = (unsigned long long)a->cancel_flag;\n`;
	c += `\tself->future = (unsigned long long)f;\n`;
	c += `\tself->started = 0;\n`;
	c += `\treturn self;\n`;
	c += `}\n`;

	if (!status.file_scope_c) status.file_scope_c = "";
	status.file_scope_c += c;

	// --- Assembly: build arg registers and call the constructor helper ---
	status.code += `// spawn construction site ${id} (${kind})\n`;
	const fat_string_args = call.params.map(spawn_arg_is_string);
	const arg_slot: number[] = [];
	let total_arg_slots = 0;
	for (let i = 0; i < call.params.length; i++) {
		arg_slot.push(total_arg_slots);
		total_arg_slots += fat_string_args[i] ? 2 : 1;
	}

	if (total_arg_slots === 0) {
		status.code += `bl _${helper_name}\n`;
	} else {
		const args_base = allocate_stack_space(status, total_arg_slots * 8, 16);
		for (let i = 0; i < call.params.length; i++) {
			status.code += `// Build arg${i}\n`;
			build_node(call.params[i], status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `str x0, [x29, #${args_base + arg_slot[i] * 8}]\n`;
			if (fat_string_args[i]) {
				status.code += `str x1, [x29, #${args_base + (arg_slot[i] + 1) * 8}]\n`;
			}
		}
		const NUM_REG_ARGS = 8;
		const overflow_count = Math.max(0, total_arg_slots - NUM_REG_ARGS);
		if (overflow_count > 0) {
			const outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
			status.code += `sub sp, sp, #${outgoing_size}\n`;
			for (let k = 0; k < overflow_count; k++) {
				status.code += `ldr x9, [x29, #${args_base + (NUM_REG_ARGS + k) * 8}]\n`;
				status.code += `str x9, [sp, #${k * 8}]\n`;
			}
		}
		for (let s = 0; s < Math.min(total_arg_slots, NUM_REG_ARGS); s++) {
			status.code += `ldr x${s}, [x29, #${args_base + s * 8}]\n`;
		}
		status.code += `bl _${helper_name}\n`;
		if (overflow_count > 0) {
			const outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
			status.code += `add sp, sp, #${outgoing_size}\n`;
		}
	}
	// x0 = the Thread/Fiber instance pointer.
}
