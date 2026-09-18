import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import { emit_address_of } from "./build_access_node.ts";
import build_node from "./build_node.ts";
import { ensure_concurrency_runtime_a64 } from "./build_spawn_node.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";

/**
 * Fiber scheduler runtime (ASYNC_PLAN.md Phase 1), aarch64 backend.
 *
 * Same scheduler as the C backend's FIBER_HEADER (which see), but the
 * context switch is a naked-asm function compiled into the companion C —
 * 13 words (x19–x28, FP, LR, SP) per context, ~30 instructions per switch,
 * no ucontext. The raw-asm-called helpers (__nomen_fiber_yield,
 * __nomen_fiber_is_active, __nomen_fiber_set_cooperative — reached from
 * Fiber.nm's `#arch: aarch64` bodies as ___nomen_fiber_*) are non-static.
 */

/**
 * Build a `.start()` / `.start_on(buf)` launch on a `Fiber(fn(args))`
 * construction (or a stored Fiber binding) — aarch64 backend
 * (docs/CLOSURE_PLAN.md Phase 3b). A companion-C helper reads the packed
 * handles from the receiver's fields and launches the task closure on the
 * fiber scheduler (a heap stack, or the caller's fixed-size array buffer
 * for start_on — validated at check time, >= 16 KB), registers the future
 * with the enclosing nursery (if any), transfers the handles out of the
 * instance, and returns Task<T> (or NULL, fire-and-forget); the assembly
 * builds the receiver pointer and calls it.
 */
export default function build_fiber_spawn_node(
	access_func: AccessFunctionCallNode,
	target: BaseNode,
	status: BuildStatus,
	start_on?: BaseNode,
) {
	ensure_concurrency_runtime_a64(status);
	status.used_fibers = true;

	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;
	const helper_name = `nomen_fiber_${id}_start`;

	const t_arg = spawn_result_type_arg(access_func.function_return_type);
	const mono_fiber = mono_type_name("Fiber", [t_arg]);
	const mono_task_name = mono_type_name("Task", [t_arg]);

	const nursery_id = status.nursery_stack?.at(-1);
	const nursery_off =
		nursery_id !== undefined ? status.nursery_offsets?.get(nursery_id) : undefined;
	const fire_and_forget = !!access_func.is_statement;
	// A chained launch consumes a TEMPORARY instance (see build_thread_start).
	const target_is_temp =
		target.node_type === "func_call" &&
		!!((target as FunctionCallNode).is_thread_ctor || (target as FunctionCallNode).is_fiber_ctor);
	const refs = fire_and_forget
		? nursery_id !== undefined
			? 2
			: 1
		: nursery_id !== undefined
			? 3
			: 2;

	// --- Companion C: the launch helper ---
	let c = `// --- fiber start site ${id} ---\n`;
	c += `void *${helper_name}(void *self`;
	let trailing = "";
	if (nursery_off) {
		trailing += `void **__nomen_nursery_futures, int *__nomen_nursery_count, int *__nomen_nursery_cap`;
	}
	if (start_on) {
		trailing += `${trailing ? ", " : ""}void *__nomen_stack, unsigned long long __nomen_stack_size`;
	}
	if (trailing) c += `, ${trailing}`;
	c += `) {\n`;
	c += `\tstruct ${mono_fiber} *t = (struct ${mono_fiber} *)self;\n`;
	c += `\tstruct nomen_future *f = (struct nomen_future *)t->future;\n`;
	c += `\tvoid *result_ptr = (void *)t->result_slot;\n`;
	c += `\tunsigned long long *cancel_ptr = (unsigned long long *)t->cancel_flag;\n`;
	c += `\tstruct nomen_closure *cl = (struct nomen_closure *)t->task;\n`;
	c += `\tf->refs = ${refs};\n`;
	c += `\t__nomen_fiber_spawn${start_on ? "_on" : ""}(cl, f${
		start_on ? ", __nomen_stack, (size_t)__nomen_stack_size" : ""
	});\n`;
	if (nursery_off) {
		c += `\t__nomen_nursery_track(__nomen_nursery_futures, __nomen_nursery_count, __nomen_nursery_cap, f);\n`;
	}
	// Transfer the handles out of the instance (started; #destroy no-ops).
	c += `\tt->task = 0;\n`;
	c += `\tt->future = 0;\n`;
	c += `\tt->result_slot = 0;\n`;
	c += `\tt->cancel_flag = 0;\n`;
	c += `\tt->started = 1;\n`;
	if (target_is_temp) c += `\tfree(t);\n`;
	if (fire_and_forget) {
		c += `\treturn (void *)0;\n`;
	} else {
		c += `\tstruct ${mono_task_name} *task = (struct ${mono_task_name} *)malloc(sizeof(struct ${mono_task_name}));\n`;
		c += `\ttask->handle = 0;\n`;
		c += `\ttask->done = 0;\n`;
		c += `\ttask->result_slot = (unsigned long long)result_ptr;\n`;
		c += `\ttask->cancel_flag = (unsigned long long)cancel_ptr;\n`;
		c += `\ttask->future = (unsigned long long)f;\n`;
		c += `\treturn task;\n`;
	}
	c += `}\n`;
	if (!status.file_scope_c) status.file_scope_c = "";
	status.file_scope_c += c;

	// --- Assembly: receiver pointer (+ nursery addresses + stack buffer) ---
	status.code += `// fiber start site ${id}\n`;
	build_node(target, status);
	if (!status.code.endsWith("\n")) status.code += "\n";

	// The trailing args park the receiver pointer in a stack slot first:
	// emitting the buffer address / nursery addresses can clobber x0.
	let extra_slots = 0;
	if (nursery_off) extra_slots += 3;
	if (start_on) extra_slots += 2;
	if (extra_slots > 0) {
		const park = allocate_stack_space(status, 8, 8);
		status.code += `str x0, [x29, #${park}]\n`;
		if (nursery_off) {
			status.code += `add x1, x29, #${nursery_off.futures_off}\n`;
			status.code += `add x2, x29, #${nursery_off.count_off}\n`;
			status.code += `add x3, x29, #${nursery_off.cap_off}\n`;
		}
		if (start_on) {
			// The stack buffer is passed by ADDRESS (a word), plus its size.
			status.code += `// Build stack buffer address\n`;
			emit_address_of(start_on, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `mov x${nursery_off ? 4 : 1}, x0\n`;
			const buf_type = type_from_value_node(start_on);
			const elem_size = buf_type.name === "string" ? 16 : 8;
			const len_node = buf_type.length;
			const len =
				len_node && len_node.node_type === "value"
					? parseInt((len_node as unknown as { value: string }).value, 10)
					: NaN;
			status.code += `// stack size = ${Number.isNaN(len) ? 0 : len} * ${elem_size}\n`;
			status.code += `mov x${nursery_off ? 5 : 2}, #${Number.isNaN(len) ? 0 : len * elem_size}\n`;
		}
		status.code += `ldr x0, [x29, #${park}]\n`;
	}
	status.code += `bl _${helper_name}\n`;
	// x0 = Task pointer (or NULL for fire-and-forget).
}

/** The launch's T as a Type: the stamped wrapped-call return type, with
 *  void coerced to uint64 (Task's result-slot convention). */
function spawn_result_type_arg(return_type: { name?: string } | undefined): Type {
	return return_type?.name && return_type.name !== "void" && return_type.name !== "?"
		? new Type(return_type.name)
		: new Type("uint64");
}
