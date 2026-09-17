import type BuildStatus from "../build_c/BuildStatus.ts";
import c_function_name from "../build_c/utils/c_function_name.ts";
import c_type from "../build_c/utils/c_type.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import emission_label from "../build_common/emission_label.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import SpawnNode from "../nodes/SpawnNode.ts";
import { emit_address_of } from "./build_access_node.ts";
import build_node from "./build_node.ts";
import { ensure_concurrency_runtime_a64, spawn_arg_is_string } from "./build_spawn_node.ts";
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
 * Build a `Fiber(fn(args)).start()` / `.start_on(buf)` node (aarch64
 * backend). Mirrors build_spawn_node — trampoline + per-site submit helper
 * in the companion C, call-site asm staging the arguments — with the pool
 * submit swapped for the fiber launch. For start_on, two extra trailing
 * submit parameters carry the stack buffer's address and byte size.
 */
export default function build_fiber_spawn_node(
	node: SpawnNode,
	status: BuildStatus,
	start_on?: BaseNode,
) {
	const call = node.call;
	const func_name = c_function_name(emission_label(call.resolved_function ?? call));
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	// Emit pool + fiber infrastructure on first fiber spawn (companion C,
	// deduped; pool text first — the fiber text extends it).
	ensure_concurrency_runtime_a64(status);
	status.used_fibers = true;

	const struct_name = `__nomen_spawn_${id}_args`;
	const tramp_name = `__nomen_spawn_${id}_trampoline`;
	const submit_name = `nomen_fiber_${id}_submit`;

	// Arg C types — same rule as the Thread path (fat strings ride the
	// nomen_string pair).
	const arg_c_types: string[] = [];
	for (let i = 0; i < call.params.length; i++) {
		const arg_type = type_from_value_node(call.params[i]);
		const mono_name = mono_type_name(arg_type);
		const is_class = !!status.structs.find(
			(s: { name: string; is_class?: boolean }) => s.name === mono_name && s.is_class,
		);
		const is_trait = !!status.traits.find((t: { name: string }) => t.name === mono_name);
		arg_c_types.push(is_class || is_trait ? `struct ${mono_name} *` : `${c_type(mono_name)}`);
	}

	const return_type_name = node.function_return_type?.name;
	const returns_value = !!(
		return_type_name &&
		return_type_name !== "void" &&
		return_type_name !== "?"
	);
	const is_class_ret = returns_value
		? !!status.structs.find(
				(s: { name: string; is_class?: boolean }) => s.name === return_type_name && s.is_class,
			)
		: false;
	const c_ret_type = is_class_ret
		? `struct ${return_type_name} *`
		: returns_value
			? c_type(return_type_name)
			: "void";
	const slot_c_type = returns_value ? c_ret_type : "unsigned long long";

	// --- Trampoline + submit helper as companion C ---
	let tramp_c = `// --- fiber spawn site ${id} trampoline ---\n`;
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
	tramp_c += `\t__nomen_future_complete(a->future);\n`;
	tramp_c += `\t__nomen_future_release(a->future);\n`;
	tramp_c += `}\n`;

	// Nursery state + fire-and-forget detection.
	const nursery_id = status.nursery_stack?.at(-1);
	const nursery_off =
		nursery_id !== undefined ? status.nursery_offsets?.get(nursery_id) : undefined;
	const fire_and_forget = !!node.is_statement;
	const refs = fire_and_forget
		? nursery_id !== undefined
			? 2
			: 1
		: nursery_id !== undefined
			? 3
			: 2;

	// Submit helper: allocates args + future (same as the Thread path), then
	// launches a fiber instead of submitting to the pool. start_on appends
	// (stack, size) trailing params.
	tramp_c += `void *${submit_name}(`;
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) tramp_c += ", ";
		tramp_c += `${arg_c_types[i]} arg${i}`;
	}
	let trailing = "";
	if (nursery_id !== undefined) {
		trailing += `${trailing ? ", " : ""}void **__nomen_nursery_futures, int *__nomen_nursery_count, int *__nomen_nursery_cap`;
	}
	if (start_on) {
		trailing += `${trailing ? ", " : ""}void *__nomen_stack, unsigned long long __nomen_stack_size`;
	}
	if (trailing) tramp_c += `${arg_c_types.length ? ", " : ""}${trailing}`;
	tramp_c += `) {\n`;
	tramp_c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		tramp_c += `\ta->arg${i} = arg${i};\n`;
	}
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
	tramp_c += `\tf->fiber_waiters = NULL;\n`;
	tramp_c += `\tf->owning_fiber = 0;\n`;
	tramp_c += `\t__nomen_fiber_spawn${start_on ? "_on" : ""}(${tramp_name}, a, f${
		start_on ? ", __nomen_stack, (size_t)__nomen_stack_size" : ""
	});\n`;
	if (nursery_id !== undefined) {
		tramp_c += `\t__nomen_nursery_track(__nomen_nursery_futures, __nomen_nursery_count, __nomen_nursery_cap, f);\n`;
	}
	if (fire_and_forget) {
		tramp_c += `\treturn (void *)0;\n`;
	} else {
		const mono_task_name = mono_type_name("Task", call.type?.type_args);
		tramp_c += `\tstruct ${mono_task_name} *t = (struct ${mono_task_name} *)malloc(sizeof(struct ${mono_task_name}));\n`;
		tramp_c += `\tt->handle = 0;\n`;
		tramp_c += `\tt->done = 0;\n`;
		tramp_c += `\tt->result_slot = (unsigned long long)a->result_slot;\n`;
		tramp_c += `\tt->cancel_flag = (unsigned long long)a->cancel_flag;\n`;
		tramp_c += `\tt->future = (unsigned long long)f;\n`;
		tramp_c += `\treturn t;\n`;
	}
	tramp_c += `}\n`;

	if (!status.file_scope_c) status.file_scope_c = "";
	status.file_scope_c += tramp_c;

	// --- Call-site asm: build arg registers and call the submit helper ---
	status.code += `// fiber spawn site ${id}\n`;
	const nursery_extra = nursery_off ? 3 : 0;
	const start_on_extra = start_on ? 2 : 0;
	const fat_string_args = call.params.map(spawn_arg_is_string);
	const arg_slot: number[] = [];
	let total_arg_slots = 0;
	for (let i = 0; i < call.params.length; i++) {
		arg_slot.push(total_arg_slots);
		total_arg_slots += fat_string_args[i] ? 2 : 1;
	}
	total_arg_slots += nursery_extra + start_on_extra;

	if (total_arg_slots === 0) {
		status.code += `bl _${submit_name}\n`;
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
		let tail_slot = call.params.reduce((n, p, i) => n + (fat_string_args[i] ? 2 : 1), 0);
		if (nursery_off) {
			// Addresses of the nursery's tracking slots (futures storage,
			// count, capacity) — the helper writes back through the first.
			status.code += `add x0, x29, #${nursery_off.futures_off}\n`;
			status.code += `str x0, [x29, #${args_base + tail_slot * 8}]\n`;
			tail_slot += 1;
			status.code += `add x0, x29, #${nursery_off.count_off}\n`;
			status.code += `str x0, [x29, #${args_base + tail_slot * 8}]\n`;
			tail_slot += 1;
			status.code += `add x0, x29, #${nursery_off.cap_off}\n`;
			status.code += `str x0, [x29, #${args_base + tail_slot * 8}]\n`;
			tail_slot += 1;
		}
		if (start_on) {
			// The stack buffer is passed by ADDRESS (a word), plus its size.
			status.code += `// Build stack buffer address\n`;
			emit_address_of(start_on, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `str x0, [x29, #${args_base + tail_slot * 8}]\n`;
			tail_slot += 1;
			const buf_type = type_from_value_node(start_on);
			const elem_size = buf_type.name === "string" ? 16 : 8;
			const len_node = buf_type.length;
			const len =
				len_node && len_node.node_type === "value"
					? parseInt((len_node as unknown as { value: string }).value, 10)
					: NaN;
			status.code += `// stack size = ${Number.isNaN(len) ? 0 : len} * ${elem_size}\n`;
			status.code += `mov x0, #${Number.isNaN(len) ? 0 : len * elem_size}\n`;
			status.code += `str x0, [x29, #${args_base + tail_slot * 8}]\n`;
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
		status.code += `bl _${submit_name}\n`;
		if (overflow_count > 0) {
			const outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
			status.code += `add sp, sp, #${outgoing_size}\n`;
		}
	}
	// x0 = Task pointer (returned by submit helper).
}
