import type BuildStatus from "../build_c/BuildStatus.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import { ensure_concurrency_runtime_a64 } from "./build_spawn_node.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
import {
	allocate_stack_space,
	emit_deref_var_address,
	emit_var_address,
} from "./utils/stack_var.ts";
import { get_struct_size } from "./utils/struct_layout.ts";

/**
 * Build a `name.start(Thread(fn(args)))` escape-hatch call for aarch64
 * (CLOSURE.md Phase 3b).
 *
 * A companion-C helper reads the packed handles from the Thread instance,
 * submits the task closure, registers the future with the nursery's
 * futures/count pointers, and fills the sret Task handle; the assembly
 * builds the Thread argument (the construction, whose eager packing happens
 * right there), loads the receiver Nursery struct's tracking pointers, and
 * calls the helper. The nursery's pointers are loaded at runtime from the
 * receiver struct (rather than compile-time-known stack offsets), since the
 * spawn may happen inside a function that received the nursery as a
 * `ref Nursery` parameter.
 *
 * Thread and Task are OWNING STRUCTS (STRUCT_PLAN_3 Phase R, tranche 2):
 * the construction leaves the instance's ADDRESS in x0 (the value-struct
 * sret convention), and the launch writes the Task handle through the
 * helper's leading `out` parameter, leaving its buffer address in x0 —
 * no heap instance, no `_vt`, no temp frees.
 *
 * See ASYNC.md, "Escape hatch: passing the nursery".
 */
export default function build_nursery_spawn(
	node: AccessNode,
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
) {
	if (access_func.params.length !== 1) return;
	const arg = access_func.params[0];

	ensure_concurrency_runtime_a64(status);

	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;
	const helper_name = `nomen_spawn_${id}_nstart`;

	const fire_and_forget = !!access_func.is_statement;
	const refs = fire_and_forget ? 2 : 3;
	const t_arg = spawn_result_type_arg(access_func.function_return_type);
	const mono_thread = mono_type_name("Thread", [t_arg]);
	const mono_task_name = mono_type_name("Task", [t_arg]);

	// --- Companion C: the launch helper ---
	let c = `// --- nursery spawn site ${id} ---\n`;
	c += `void ${helper_name}(struct ${mono_task_name} *out, struct ${mono_thread} *t, void **__nomen_nursery_futures, int *__nomen_nursery_count, int *__nomen_nursery_cap) {\n`;
	c += `\tstruct nomen_future *f = (struct nomen_future *)t->future;\n`;
	c += `\tvoid *result_ptr = (void *)t->result_slot;\n`;
	c += `\tunsigned long long *cancel_ptr = (unsigned long long *)t->cancel_flag;\n`;
	c += `\tstruct nomen_closure *cl = (struct nomen_closure *)t->task;\n`;
	c += `\tf->refs = ${refs};\n`;
	c += `\t__nomen_pool_submit(cl);\n`;
	c += `\t__nomen_nursery_track(__nomen_nursery_futures, __nomen_nursery_count, __nomen_nursery_cap, f);\n`;
	// Transfer the handles out of the instance (started; #destroy no-ops).
	c += `\tt->task = 0;\n`;
	c += `\tt->future = 0;\n`;
	c += `\tt->result_slot = 0;\n`;
	c += `\tt->cancel_flag = 0;\n`;
	c += `\tt->started = 1;\n`;
	// The Task handle: an inline mv struct VALUE (Phase R tranche 2) —
	// no heap instance, no `_vt` (a value struct has no embedded vtable;
	// trait dispatch rides boxed handles). Fire-and-forget discards it.
	c += `\tout->handle = 0;\n`;
	c += `\tout->done = 0;\n`;
	c += `\tout->result_slot = (unsigned long long)result_ptr;\n`;
	c += `\tout->cancel_flag = (unsigned long long)cancel_ptr;\n`;
	c += `\tout->future = (unsigned long long)f;\n`;
	c += `}\n`;
	if (!status.file_scope_c) status.file_scope_c = "";
	status.file_scope_c += c;

	// --- Assembly: helper(out=x0, t=x1, futures=x2, count=x3, cap=x4) ---
	emit_asm(status, `// nursery spawn site ${id}\n`);
	const futures_park = allocate_stack_space(status, 8, 8);
	const count_park = allocate_stack_space(status, 8, 8);
	const cap_park = allocate_stack_space(status, 8, 8);
	const self_park = allocate_stack_space(status, 8, 8);
	const task_buf = allocate_stack_space(status, get_struct_size(mono_task_name, status), 8);

	// Load the Nursery struct address into x0, then park it. Its tracking
	// pointers — futures storage (offset 0, the ADDRESS of the async block's
	// list slot so the helper can realloc in place), count (offset 8), and
	// capacity (offset 16) — are parked in their own slots after the Thread
	// argument is built (emitting it can clobber x0..x4).
	load_nursery_struct_address(node.target, status);
	ensure_newline(status);
	emit_asm(status, `str x0, [x29, #${futures_park}]\n`);
	// Build the Thread argument (the construction packs eagerly; the
	// value-struct convention leaves the instance's ADDRESS in x0), park it,
	// load the nursery pointers, then stage the helper's arguments.
	build_node(arg, status);
	ensure_newline(status);
	emit_asm(status, `str x0, [x29, #${self_park}]\n`);
	emit_asm(status, `ldr x0, [x29, #${futures_park}]\n`);
	emit_asm(status, `ldr x9, [x0, #0]\n`); // futures_ptr (→ &list slot)
	emit_asm(status, `str x9, [x29, #${futures_park}]\n`);
	emit_asm(status, `ldr x9, [x0, #8]\n`); // count_ptr
	emit_asm(status, `str x9, [x29, #${count_park}]\n`);
	emit_asm(status, `ldr x9, [x0, #16]\n`); // cap_ptr
	emit_asm(status, `str x9, [x29, #${cap_park}]\n`);
	// x0 = the Task sret buffer, x1 = the Thread instance's address,
	// x2..x4 = the nursery tracking pointers.
	emit_asm(status, `add x0, x29, #${task_buf}\n`);
	emit_asm(status, `ldr x1, [x29, #${self_park}]\n`);
	emit_asm(status, `ldr x2, [x29, #${futures_park}]\n`);
	emit_asm(status, `ldr x3, [x29, #${count_park}]\n`);
	emit_asm(status, `ldr x4, [x29, #${cap_park}]\n`);
	emit_asm(status, `bl _${helper_name}\n`);
	// x0 = the Task handle's address (the value-struct convention: the
	// consuming context — a declaration's word copy or a discarded
	// statement — reads the buffer through it).
	emit_asm(status, `add x0, x29, #${task_buf}\n`);
}

/** The launch's T as a Type: the stamped wrapped-call return type, with
 *  void coerced to uint64 (Task's result-slot convention). */
function spawn_result_type_arg(return_type: { name?: string } | undefined): Type {
	return return_type?.name && return_type.name !== "void" && return_type.name !== "?"
		? new Type(return_type.name)
		: new Type("uint64");
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
