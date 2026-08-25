import type BuildStatus from "../build_c/BuildStatus.ts";
import c_function_name from "../build_c/utils/c_function_name.ts";
import c_type from "../build_c/utils/c_type.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import { POOL_HEADER_C } from "./build_spawn_node.ts";
import {
	allocate_stack_space,
	emit_deref_var_address,
	emit_var_address,
} from "./utils/stack_var.ts";

/**
 * Build a `name.spawn(fn(args))` escape-hatch call for aarch64.
 *
 * Mirrors build_spawn_node (aarch64): the per-site trampoline + submit helper
 * are emitted as C in the companion file; the assembly builds the arg struct
 * and calls the helper. The difference is that the nursery's futures/count
 * addresses are loaded at runtime from the receiver Nursery struct (rather
 * than compile-time-known stack offsets), since the spawn may happen inside a
 * function that received the nursery as a `ref Nursery` parameter.
 *
 * The single parameter is the call expression to spawn (same shape as bare
 * `spawn fn(args)`). See ASYNC.md, "Escape hatch: passing the nursery".
 */
export default function build_nursery_spawn(
	node: AccessNode,
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
) {
	if (access_func.params.length !== 1 || access_func.params[0].node_type !== "func_call") return;
	const call = access_func.params[0] as FunctionCallNode;
	const func_name = c_function_name(call.name);
	const args = call.params;

	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	if (!status.file_scope_c?.includes("__nomen_pool_submit")) {
		status.file_scope_c = (status.file_scope_c ?? "") + POOL_HEADER_C;
	}

	const struct_name = `__nomen_spawn_${id}_args`;
	const tramp_name = `__nomen_spawn_${id}_trampoline`;
	const submit_name = `nomen_spawn_${id}_submit`;

	// Resolve each arg's C type. Primitives and the fat `string` (the
	// 16-byte nomen_string — two AAPCS register slots) go through c_type so
	// the companion C signature matches the asm's actual 64-bit values;
	// classes/traits are heap pointers. Mirrors build_spawn_node (aarch64).
	const arg_c_types: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg_type = type_from_value_node(args[i]);
		const mono_name = mono_type_name(arg_type);
		const is_class = !!status.structs.find((s) => s.name === mono_name && s.is_class);
		const is_trait = !!status.traits.find((t) => t.name === mono_name);
		arg_c_types.push(is_class || is_trait ? `struct ${mono_name} *` : `${c_type(mono_name)}`);
	}

	// Determine return type.
	const return_type_name = access_func.function_return_type?.name;
	const returns_value = !!(
		return_type_name &&
		return_type_name !== "void" &&
		return_type_name !== "?"
	);
	const is_class_ret = returns_value
		? !!status.structs.find((s) => s.name === return_type_name && s.is_class)
		: false;
	const c_ret_type = is_class_ret
		? `struct ${return_type_name} *`
		: returns_value
			? c_type(return_type_name)
			: "void";
	// The result cell is always 16 bytes — see build_spawn_node (aarch64).
	const slot_c_type = returns_value ? c_ret_type : "unsigned long long";

	// --- Trampoline + submit helper (C companion) ---

	let tramp_c = `// --- nursery spawn site ${id} trampoline ---\n`;
	tramp_c += `${c_ret_type} ${func_name}(`;
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) tramp_c += ", ";
		tramp_c += `${arg_c_types[i]}`;
	}
	tramp_c += `);\n`;
	tramp_c += `struct ${struct_name} {\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		tramp_c += `\t${arg_c_types[i]} arg${i};\n`;
	}
	tramp_c += `\t${slot_c_type} *result_slot;\n`;
	tramp_c += `\tunsigned long long *cancel_flag;\n`;
	tramp_c += `\tstruct nomen_future *future;\n`;
	tramp_c += `};\n`;

	tramp_c += `static void ${tramp_name}(void *p) {\n`;
	tramp_c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)p;\n`;
	tramp_c += `\t__nomen_current_cancel_flag = a->cancel_flag;\n`;
	if (returns_value) {
		tramp_c += `\t${c_ret_type} _r = ${func_name}(`;
	} else {
		tramp_c += `\t${func_name}(`;
	}
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) tramp_c += ", ";
		tramp_c += `a->arg${i}`;
	}
	tramp_c += `);\n`;
	if (returns_value) {
		tramp_c += `\t*(a->result_slot) = _r;\n`;
	}
	tramp_c += `\t__nomen_current_cancel_flag = NULL;\n`;
	tramp_c += `\tpthread_mutex_lock(&a->future->mu);\n`;
	tramp_c += `\ta->future->done = 1;\n`;
	tramp_c += `\tpthread_cond_broadcast(&a->future->cv);\n`;
	tramp_c += `\tpthread_mutex_unlock(&a->future->mu);\n`;
	tramp_c += `\t__nomen_future_release(a->future);\n`; // a freed via f->owner_args at last release
	tramp_c += `}\n`;

	// A nursery.spawn always tracks its future with a nursery (that's the
	// point), so the submit helper always takes the futures/count pointers.
	const fire_and_forget = !!access_func.is_statement;
	const refs = fire_and_forget ? 2 : 3;

	tramp_c += `void *${submit_name}(`;
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) tramp_c += ", ";
		tramp_c += `${arg_c_types[i]} arg${i}`;
	}
	if (arg_c_types.length > 0) tramp_c += ", ";
	tramp_c += `unsigned long long *__nomen_nursery_futures, int *__nomen_nursery_count`;
	tramp_c += `) {\n`;
	tramp_c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		tramp_c += `\ta->arg${i} = arg${i};\n`;
	}
	// Uniform 16-byte cell (see slot_c_type above), zeroed so the unwritten
	// len half of a scalar result reads 0.
	tramp_c += `\ta->result_slot = (${slot_c_type} *)malloc(16);\n`;
	tramp_c += `\tmemset(a->result_slot, 0, 16);\n`;
	tramp_c += `\ta->cancel_flag = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	tramp_c += `\t*(a->cancel_flag) = 0;\n`;
	tramp_c += `\tstruct nomen_future *f = (struct nomen_future *)malloc(sizeof(struct nomen_future));\n`;
	tramp_c += `\tpthread_mutex_init(&f->mu, NULL);\n`;
	tramp_c += `\tpthread_cond_init(&f->cv, NULL);\n`;
	tramp_c += `\tf->done = 0;\n`;
	tramp_c += `\tf->refs = ${refs};\n`;
	tramp_c += `\tf->cancel_flag = a->cancel_flag;\n`;
	tramp_c += `\tf->result_slot = a->result_slot;\n`;
	tramp_c += `\ta->future = f;\n`;
	tramp_c += `\tf->owner_args = a;\n`;
	tramp_c += `\t__nomen_pool_submit(${tramp_name}, a);\n`;
	tramp_c += `\t__nomen_nursery_futures[(*__nomen_nursery_count)++] = (unsigned long long)f;\n`;
	if (fire_and_forget) {
		tramp_c += `\treturn (void *)0;\n`;
	} else {
		const task_type_args = access_func.type?.type_args;
		const mono_task_name = mono_type_name("Task", task_type_args);
		tramp_c += `\tstruct ${mono_task_name} *t = (struct ${mono_task_name} *)malloc(sizeof(struct ${mono_task_name}));\n`;
		tramp_c += `\tt->handle = 0;\n`;
		tramp_c += `\tt->done = 0;\n`;
		tramp_c += `\tt->result_slot = (unsigned long long)a->result_slot;\n`;
		tramp_c += `\tt->cancel_flag = (unsigned long long)a->cancel_flag;\n`;
		tramp_c += `\tt->future = (unsigned long long)f;\n`;
		tramp_c += `\treturn t;\n`;
	}
	tramp_c += `}\n`;

	status.file_scope_c += tramp_c;

	// --- Assembly: load nursery futures/count, build args, call submit ---

	// A fat `string` argument rides the (ptr, len) pair in x0/x1 and occupies
	// TWO consecutive AAPCS slots (see build_spawn_node aarch64). The two
	// trailing nursery futures/count args always follow.
	const fat_string_args = args.map(spawn_arg_is_string);
	const arg_slot: number[] = [];
	let fn_arg_slots = 0;
	for (let i = 0; i < args.length; i++) {
		arg_slot.push(fn_arg_slots);
		fn_arg_slots += fat_string_args[i] ? 2 : 1;
	}
	const total_arg_slots = fn_arg_slots + 2;

	status.code += `// nursery spawn site ${id}\n`;
	const args_base = allocate_stack_space(status, total_arg_slots * 8, 16);

	// Load the Nursery struct address into x0, then load futures_ptr (offset 0)
	// and count_ptr (offset 8) and store them to the trailing arg slots.
	load_nursery_struct_address(node.target, status);
	status.code += `ldr x1, [x0, #0]\n`; // futures_ptr
	status.code += `str x1, [x29, #${args_base + (total_arg_slots - 2) * 8}]\n`;
	status.code += `ldr x1, [x0, #8]\n`; // count_ptr
	status.code += `str x1, [x29, #${args_base + (total_arg_slots - 1) * 8}]\n`;

	// Build each function arg and spill it to its slot(s).
	for (let i = 0; i < args.length; i++) {
		status.code += `// Build arg${i}\n`;
		build_node(args[i], status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `str x0, [x29, #${args_base + arg_slot[i] * 8}]\n`;
		if (fat_string_args[i]) {
			// The pair's len half rides x1 — spill both halves.
			status.code += `str x1, [x29, #${args_base + (arg_slot[i] + 1) * 8}]\n`;
		}
	}

	// Load each staged slot into its argument register. Slots past x0..x7 go
	// in the caller's outgoing area at [sp] for the call (AAPCS64).
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
	status.code += `bl _${submit_name}\n`;
	if (overflow_count > 0) {
		const outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
		status.code += `add sp, sp, #${outgoing_size}\n`;
	}
	// x0 = Task pointer (or NULL for fire-and-forget).
}

/**
 * Whether a spawn argument rides the fat-string (ptr, len) pair ABI — mirrors
 * build_spawn_node (aarch64).
 */
function spawn_arg_is_string(node: BaseNode): boolean {
	const v = node as { value?: string };
	if (node.node_type === "value" && typeof v.value === "string" && v.value.startsWith('"')) {
		return true;
	}
	const t = type_from_value_node(node);
	return t?.name === "string" && !t.is_view && !t.is_array;
}

/**
 * Emit assembly that loads the address of the Nursery struct (the receiver of
 * a name.spawn) into x0. A `ref Nursery` parameter holds the struct address
 * (emit_deref_var_address yields it); the async block's named local lives on
 * the stack (emit_var_address yields its address); any other Nursery lvalue
 * falls back to build_node.
 */
function load_nursery_struct_address(target: AccessNode["target"], status: BuildStatus) {
	if (target.node_type === "value") {
		const name = (target as ValueNode).value;
		// ref Nursery param: the pointer it holds IS the struct address.
		if (status.function_ref_params?.has(name)) {
			emit_deref_var_address(status, "x0", name);
			return;
		}
		// Named nursery local declared by the enclosing async block.
		if (status.stack_offsets?.has(name)) {
			emit_var_address(status, "x0", name);
			return;
		}
	}
	build_node(target, status);
}
