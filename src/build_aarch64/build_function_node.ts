import type BuildStatus from "../build_c/BuildStatus.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import type Type from "../nodes/Type.ts";
import build_block_node from "./build_block_node.ts";
import { check_c_fallback } from "./build_raw_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_free } from "./utils/audit.ts";
import { emit_destroy_for_anchor_slot } from "./utils/auto_destroy.ts";
import scan_force_heap_strings from "./utils/scan_force_heap_strings.ts";
import {
	NUM_REG_ARGS,
	overflow_placeholder,
	patch_overflow_placeholders,
} from "./utils/stack_args.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

function peephole_optimize(code: string): string {
	const conditions: Record<string, string> = {
		eq: "ne",
		ne: "eq",
		gt: "le",
		ge: "lt",
		lt: "ge",
		le: "gt",
		hi: "ls",
		hs: "lo",
		lo: "hs",
		ls: "hi",
	};

	const lines = code.split("\n");

	// Pass 1: cset + cmp #0 + b.eq/b.ne → direct conditional branch
	{
		const out: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === "") {
				out.push(lines[i]);
				continue;
			}
			const cset_match = lines[i].match(/^(\s*)cset x0, (\w+)\s*$/);
			if (cset_match) {
				let j = i + 1;
				while (j < lines.length && lines[j].trim() === "") j++;
				if (j < lines.length) {
					const cmp_match = lines[j].match(/^(\s*)cmp x0, #0\s*$/);
					if (cmp_match) {
						let k = j + 1;
						while (k < lines.length && lines[k].trim() === "") k++;
						if (k < lines.length) {
							const branch_match = lines[k].match(/^(\s*)b(eq|ne)\s+(\S+)\s*$/);
							if (branch_match) {
								const indent = cset_match[1];
								const cond = cset_match[2];
								const branch_cond = branch_match[2];
								const label = branch_match[3];
								if (branch_cond === "eq") {
									out.push(`${indent}b.${conditions[cond] || "ne"} ${label}`);
								} else {
									out.push(`${indent}b.${cond} ${label}`);
								}
								i = k;
								continue;
							}
						}
					}
				}
			}
			out.push(lines[i]);
		}
		lines.length = 0;
		lines.push(...out);
	}

	// Pass 2: eliminate immediately-adjacent str xN, [sp, #-16]! / ldr xN, [sp], #16
	// A push immediately followed by a pop of the same register is unconditionally a
	// no-op (sp unchanged, register unchanged). Only matches when no instructions
	// separate them (blank lines are OK). This removes the redundant spill/reload
	// that the assignment and declaration codegen inserts between computing a
	// value and storing it to a register-allocated variable.
	{
		const out: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const push_match = lines[i].match(/^\s*str (x\d+|d\d+), \[sp, #-16\]!\s*$/);
			if (push_match) {
				const reg = push_match[1];
				let j = i + 1;
				while (j < lines.length && lines[j].trim() === "") j++;
				if (j < lines.length) {
					const esc_reg = reg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					const pop_re = new RegExp(`^\\s*ldr ${esc_reg}, \\[sp\\], #16\\s*$`);
					if (pop_re.test(lines[j])) {
						i = j;
						continue;
					}
				}
			}
			out.push(lines[i]);
		}
		lines.length = 0;
		lines.push(...out);
	}

	// Disabled - causes incorrect code generation for some patterns
	// {
	// 	const out: string[] = [];
	// 	for (let i = 0; i < lines.length; i++) {
	// 		const push_match = lines[i].match(/^(\s*)str x3, \[sp, #-16\]!\s*$/);
	// 		if (push_match) {
	// 			let j = i + 1;
	// 			let safe = true;
	// 			while (j < lines.length && !/^(\s*)ldr x3, \[sp\], #16\s*$/.test(lines[j])) {
	// 				const trimmed = lines[j].trim();
	// 				if (trimmed === "" || trimmed.startsWith("//")) {
	// 					j++;
	// 					continue;
	// 				}
	// 				if (/\bx3\b/.test(trimmed) || /\bsp\b/.test(trimmed)) {
	// 					safe = false;
	// 					break;
	// 				}
	// 				j++;
	// 			}
	// 			if (safe && j < lines.length && /^(\s*)ldr x3, \[sp\], #16\s*$/.test(lines[j])) {
	// 				i = j;
	// 				continue;
	// 			}
	// 		}
	// 		out.push(lines[i]);
	// 	}
	// 	lines.length = 0;
	// 	lines.push(...out);
	// }

	return lines.join("\n");
}

export default function build_function_node(node: FunctionNode, status: BuildStatus) {
	if (node.is_generic) return;
	if (check_c_fallback(node, undefined, status)) return;

	const old_function_name = status.current_function_name;
	status.current_function_name = node.name;

	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];

	const old_moved: Set<string> | undefined = status.moved;
	(status.moved as Set<string> | undefined) = undefined;

	const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];

	const old_return_label = status.function_return_label;
	const return_label = `.return_${label_counter}`;
	const keep_prefix = `.Lkeep_${label_counter}`;
	label_counter++;
	status.function_return_label = return_label;

	const is_nested = !!old_return_label && node.name !== "main";

	let old_code: string | undefined;
	if (is_nested) {
		old_code = status.code;
		status.code = "";
	}

	// A `view T` return is a (ptr, len) pair in x0/x1 — never a sret struct,
	// even when the element T is itself a struct. Exclude views here so a
	// `view User` slice return isn't misclassified as a struct return.
	const return_struct =
		!node.return_type.is_view &&
		!!status.structs.find(
			(s) => s.name === node.return_type.name && !s.is_simple_type && !s.is_class,
		);
	if (return_struct) {
		status.struct_return_buffer = "x8";
	}
	status.function_return_type = node.return_type;
	const old_stack_size = status.stack_size;
	const old_stack_offsets = status.stack_offsets;
	status.stack_size = 0;
	status.stack_offsets = new Map();

	const has_body = node.has_body && node.statements.length > 0;

	const callee_saved = ["x19", "x20", "x21", "x22"];
	const callee_map = new Map<string, string>();
	let callee_idx = 0;

	status.code += `.p2align 2\n`;
	if (node.name === "main") {
		status.code += `.globl _main\n`;
	}
	// Make user functions visible to the companion C file (spawn trampolines
	// call user functions defined in assembly). On macOS, C symbols have a
	// leading _ prefix, so we define both the bare label (for bl references
	// from other assembly) and the _-prefixed label (for C linkage).
	const label_name = node.name.replace(/#/g, "");
	if (node.name === "main") {
		status.code += `_main:\n`;
	} else {
		status.code += `.globl ${label_name}\n`;
		status.code += `${label_name}:\n`;
		if (status.platform !== "windows") {
			status.code += `.globl _${label_name}\n`;
			status.code += `_${label_name} = ${label_name}\n`;
		}
	}
	status.code += `stp x29, x30, [sp, #-16]!\n`;

	const is_main_with_init =
		node.name === "main" &&
		has_body &&
		node.params.length > 0 &&
		node.params[0].type.name === "Init";
	let init_struct_size = 0;
	if (is_main_with_init) {
		const vt_size = 8;
		const argc_offset = vt_size;
		const args_offset = vt_size + 8;
		const args_count = 16;
		init_struct_size = args_offset + args_count * 8;
		status.code += `sub sp, sp, #${init_struct_size}\n`;
		status.code += `str x0, [sp, #${argc_offset}]\n`;
		status.code += `str x1, [sp, #${args_offset}]\n`;
		status.code += `mov x20, x1\n`;
		status.code += `mov x2, #0\n`;
		const loop_label = `.Linit_loop_${label_counter}`;
		const end_label = `.Linit_end_${label_counter}`;
		label_counter++;
		status.code += `${loop_label}:\n`;
		status.code += `ldr x3, [sp, #${argc_offset}]\n`;
		status.code += `cmp x2, x3\n`;
		status.code += `b.ge ${end_label}\n`;
		status.code += `cmp x2, #${args_count}\n`;
		status.code += `b.ge ${end_label}\n`;
		status.code += `ldr x0, [x20, x2, lsl #3]\n`;
		status.code += `add x3, x2, #2\n`;
		status.code += `str x0, [sp, x3, lsl #3]\n`;
		status.code += `add x2, x2, #1\n`;
		status.code += `b ${loop_label}\n`;
		status.code += `${end_label}:\n`;
		status.code += `mov x0, sp\n`;
	}

	if (has_body) {
		// Track the AAPCS64 register slot index (variadic = 2 slots, array = 1,
		// everything else = 1). The previous loop used the raw params index,
		// which under-counted in the presence of a variadic param and so read
		// the wrong register for a struct param that followed one.
		let first_pass_slot = 0;
		for (let i = 0; i < node.params.length; i++) {
			const param = node.params[i];
			// Array-typed params (including variadic) hold a pointer, not a
			// struct value — don't classify them as struct params.
			if (param.is_variadic) {
				first_pass_slot += 2;
				continue;
			}
			if (param.type.is_array) {
				first_pass_slot += 1;
				continue;
			}
			// A class param is a reference type (a heap pointer), but the body
			// accesses it as a pointer VALUE — so it still belongs in the
			// callee-saved register path (saved like a struct param and read
			// back as a value). Excluding it here would spill it to a stack
			// slot that the method-receiver load treats as a by-address struct
			// (address-of instead of load), corrupting class params. See
			// trait_dispatch / class-move / memory-var-class-param tests.
			const is_struct_type = !!status.structs.find(
				(s) => s.name === param.type.name && !s.is_simple_type,
			);
			// A trait-typed param arrives as a pointer to the concrete struct
			// (whose vtable lives at offset 0), so save it in a callee-saved
			// register like a struct param — trait-typed dispatch reads the
			// receiver pointer from there.
			const is_trait_type = !!status.traits.find((t) => t.name === param.type.name);
			const is_enum_with_data = !!status.enums.find(
				(e) => e.name === param.type.name && e.has_associated_data,
			);
			if (
				(is_struct_type || is_trait_type || is_enum_with_data) &&
				callee_idx < callee_saved.length
			) {
				const saved_reg = callee_saved[callee_idx++];
				status.code += `str ${saved_reg}, [sp, #-16]!\n`;
				if (first_pass_slot < NUM_REG_ARGS) {
					status.code += `mov ${saved_reg}, ${param_regs[first_pass_slot]}\n`;
				} else {
					// Overflow: this arg arrived in the caller's outgoing stack
					// area. After the push above, sp = caller_sp - 16 -
					// 16*callee_idx, so the k-th stack arg (slot 8+k) lives at
					// [sp, #(16 + 16*callee_idx + k*8)].
					const k = first_pass_slot - NUM_REG_ARGS;
					status.code += `ldr ${saved_reg}, [sp, #${16 + 16 * callee_idx + k * 8}]\n`;
				}
				callee_map.set(param.name, saved_reg);
			}
			first_pass_slot++;
		}
	}

	const stack_placeholder = `STACK_SIZE_${node.name}`;
	status.code += `sub sp, sp, #${stack_placeholder}\n`;
	status.code += `mov x29, sp\n`;

	if (return_struct) {
		const return_buffer_stack_offset = allocate_stack_space(status, 8, 8);
		status.code += `str x8, [x29, #${return_buffer_stack_offset}]\n`;
		status.return_buffer_stack_offset = return_buffer_stack_offset;
	}

	// Save the enclosing function's param-tracking sets so a nested function
	// build doesn't leak its params into the enclosing scope's statement
	// phase (e.g. a nested `ref Nursery pool` colliding with a same-named
	// local in the enclosing body). Restored after the body is built.
	const old_function_param_regs = status.function_param_regs;
	const old_function_param_vars = status.function_param_vars;
	const old_function_array_params = status.function_array_params;
	const old_function_ref_params = status.function_ref_params;
	const old_ref_class_slots = status.ref_class_slots;
	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	status.function_array_params = new Set();
	status.function_ref_params = new Set();
	status.ref_class_slots = new Map();
	const old_variadic_params_aarch64 = status.function_variadic_params;
	status.function_variadic_params = new Set();
	status.moved_class_params = new Map();

	// Save mov'd class param values for cleanup at return
	let moved_param_save_slots: Map<
		string,
		{ offset: number; type_name: string; type_args?: Type[]; is_nullable?: boolean }
	> = new Map();

	if (has_body) {
		let param_idx = 0;
		for (let i = 0; i < node.params.length; i++) {
			const param = node.params[i];

			if (param.is_variadic) {
				status.function_variadic_params!.add(param.name);
				// Hidden _name_len param (takes a register slot before the array ptr)
				const len_offset = allocate_stack_space(status, 8, 8);
				status.stack_offsets!.set(`_${param.name}_len`, len_offset);
				if (param_idx < NUM_REG_ARGS) {
					const len_reg = param_regs[param_idx];
					status.code += `str ${len_reg}, [x29, #${len_offset}]\n`;
				} else {
					const k = param_idx - NUM_REG_ARGS;
					status.code += `ldr x9, [x29, #${overflow_placeholder(node.name, k)}]\n`;
					status.code += `str x9, [x29, #${len_offset}]\n`;
				}
				param_idx++;
			}

			if (callee_map.has(param.name)) {
				const reg = callee_map.get(param.name)!;
				status.function_param_regs.set(param.name, reg);
				// A `ref` class param's register currently holds the ADDRESS of the
				// caller's pointer slot (the call site passes &slot so the callee
				// can reassign it). Field access expects the register to hold the
				// instance, so dereference once — and save &slot separately (in a
				// dedicated slot) for the reassignment write-back path.
				if (param.type.is_ref) {
					const is_class = !!status.structs.find((s) => s.name === param.type.name && s.is_class);
					if (is_class) {
						const ref_slot = allocate_stack_space(status, 8, 8);
						status.code += `str ${reg}, [x29, #${ref_slot}]\n`;
						status.code += `ldr ${reg}, [${reg}]\n`;
						status.ref_class_slots?.set(param.name, ref_slot);
					}
				}
			} else {
				// A `ref T` param receives an 8-byte pointer to the caller's
				// storage regardless of T's size, so the local slot must always
				// be 8 bytes (spilling `ref bool` as `strb` truncates the
				// address). The element width only matters at the dereference.
				const is_ref = param.type.is_ref;
				const size = is_ref ? 8 : aarch64_size(param.type.name);
				const offset = allocate_stack_space(status, size, is_ref ? 8 : size);
				status.stack_offsets!.set(param.name, offset);
				if (param_idx < NUM_REG_ARGS) {
					const reg = param_regs[param_idx];
					if (size === 1) {
						status.code += `strb ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
					} else if (size === 4) {
						status.code += `str ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
					} else {
						status.code += `str ${reg}, [x29, #${offset}]\n`;
					}
				} else {
					// Overflow: arg arrived on the caller's stack. Load via x9
					// (caller-saved scratch — free at the prologue) and store
					// with the param's declared width so the local slot matches
					// what the register path would have produced.
					const k = param_idx - NUM_REG_ARGS;
					status.code += `ldr x9, [x29, #${overflow_placeholder(node.name, k)}]\n`;
					if (size === 1) {
						status.code += `strb w9, [x29, #${offset}]\n`;
					} else if (size === 4) {
						status.code += `str w9, [x29, #${offset}]\n`;
					} else {
						status.code += `str x9, [x29, #${offset}]\n`;
					}
				}
			}
			param_idx++;

			if (param.declaration === "var") {
				status.function_param_vars.add(param.name);
			}
			if (param.type.is_array) {
				status.function_array_params!.add(param.name);
			}
			if (param.type.is_ref) {
				status.function_ref_params!.add(param.name);
			}
		}
	}

	const moved_before = new Set(status.moved ?? []);

	// Track mov'd class params for cleanup at return. This runs regardless of
	// whether the function has a body: a `mov Box x` param is owned by the
	// callee and must be reclaimed (with its #destroy + field destroys) even
	// when the body is empty. The incoming value is saved from whichever
	// register holds it at entry — the callee-saved register assigned during
	// the prologue, or the incoming param register when none was assigned.
	let pidx = 0;
	for (let i = 0; i < node.params.length; i++) {
		const param = node.params[i];
		if (param.is_variadic) pidx++;
		if (param.is_moved) {
			const is_class = !!status.structs.find((s) => s.name === param.type.name && s.is_class);
			if (is_class) {
				const reg = callee_map.get(param.name) ?? param_regs[pidx];
				status.moved_class_params!.set(param.name, reg);
				const save_offset = allocate_stack_space(status, 8);
				status.code += `str ${reg}, [x29, #${save_offset}]\n`;
				moved_param_save_slots.set(param.name, {
					offset: save_offset,
					type_name: param.type.name,
					type_args: param.type.type_args,
					is_nullable: param.type.is_nullable,
				});
			}
		}
		pidx++;
	}

	const old_force_heap = status.force_heap_strings;
	status.force_heap_strings = scan_force_heap_strings(node.statements);

	// Each function body starts with a fresh Buffer data-pointer cache so a
	// cache entry established while building an earlier function can't leak in
	// and produce a bogus "hit" that skips the data-pointer load.
	status.buffer_data_cache = undefined;

	build_block_node(node, status);

	status.force_heap_strings = old_force_heap;

	const loop_regs_used = status.callee_saved_regs_used
		? [...status.callee_saved_regs_used].sort()
		: [];
	status.callee_saved_regs_used = undefined;

	if (loop_regs_used.length > 0 && has_body) {
		const func_label = `${node.name === "main" ? "_" : ""}${node.name}:`;
		const func_start = status.code.indexOf(func_label);
		const search_for = `sub sp, sp, #${stack_placeholder}`;
		const after_prologue = func_start !== -1 ? status.code.indexOf(search_for, func_start) : -1;
		if (after_prologue !== -1) {
			let saves = "";
			for (const reg of loop_regs_used) {
				saves += `str ${reg}, [sp, #-16]!\n`;
			}
			status.code =
				status.code.slice(0, after_prologue) + saves + status.code.slice(after_prologue);
		}
	}

	const moved_after = status.moved;
	const heap_after = status.heap_strings;
	if (moved_after) {
		for (const name of moved_after) {
			if (moved_before.has(name)) continue;
			if (heap_after?.has(name)) {
				if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
				status.heap_returning_functions.add(node.name);
				break;
			}
		}
	}
	const return_is_class = status.structs.some(
		(s) => s.name === node.return_type.name && s.is_class,
	);
	if (return_is_class) {
		if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
		status.heap_returning_functions.add(node.name);
	}

	status.code += `${return_label}:\n`;
	if (node.name === "main") {
		// In audit mode, call nomen_audit_check at main exit (linked from
		// audit_runtime.c). If the pool was used (spawn was emitted), shut
		// it down first so workers are joined and freed — otherwise the
		// pool's atexit handler runs after audit_check and the workers
		// array shows up as a false-positive leak. (Run before `mov x0, #0`
		// so the void audit_check doesn't clobber main's return value.)
		if (status.audit) {
			if (status.file_scope_c?.includes("__nomen_pool_submit")) {
				status.code += `bl ___nomen_pool_shutdown\n`;
			}
			status.code += `bl _nomen_audit_check\n`;
		}
		status.code += `mov x0, #0\n`;
	}

	// Reclaim mov'd class params: run #destroy + field destroys (which free
	// owned class fields) then free the instance itself. Skip params that were
	// moved out within the body. When the function returns a class, also skip a
	// param whose value is the return value — it is handed back to the caller.
	// (The return-value guard is only meaningful for class returns, where x0
	// holds the returned pointer; for void/primitive returns x0 is not a live
	// return value.)
	const moved_set = status.moved;
	if (moved_param_save_slots.size > 0 && node.name !== "main") {
		const need_guard = return_is_class;
		let return_save: number | undefined;
		if (need_guard) {
			return_save = allocate_stack_space(status, 8);
			status.code += `str x0, [x29, #${return_save}]\n`;
		}
		for (const [name, info] of moved_param_save_slots) {
			if (moved_set?.has(name)) continue;
			if (need_guard) {
				status.code += `ldr x0, [x29, #${info.offset}]\n`;
				status.code += `ldr x1, [x29, #${return_save!}]\n`;
				status.code += `cmp x0, x1\n`;
				status.code += `beq ${keep_prefix}_${name}\n`;
			}
			emit_destroy_for_anchor_slot(
				status,
				info.offset,
				info.type_name,
				info.type_args,
				info.is_nullable,
			);
			status.code += `ldr x0, [x29, #${info.offset}]\n`;
			emit_free(status);
			if (need_guard) {
				status.code += `${keep_prefix}_${name}:\n`;
			}
		}
		if (need_guard) {
			status.code += `ldr x0, [x29, #${return_save!}]\n`;
		}
	}

	const total_stack = Math.ceil((status.stack_size || 0) / 16) * 16;
	status.code = status.code.replace(
		`sub sp, sp, #${stack_placeholder}`,
		total_stack > 0 ? `sub sp, sp, #${total_stack}` : `// no stack needed`,
	);
	// Now that the local frame size is known, resolve the per-overflow-arg
	// placeholders emitted in the second prologue pass to their concrete x29
	// offsets. Each `str xN, [sp, #-16]!` between `stp x29, x30, [sp, #-16]!`
	// and `sub sp, sp, #STACK_SIZE` pushes sp 16 bytes further below the
	// caller's outgoing stack args, so the offset from x29 to slot 8+k grows
	// by 16 per push: 16 + 16*(callee_idx + loop_regs_used.length) +
	// total_stack + k*8. (loop_regs_used saves are inserted just above
	// `sub sp, sp, #STACK_SIZE` after the body is built, but they sit in the
	// emitted instruction stream between the first-pass saves and the sub, so
	// they count here.)
	if (total_stack > 0) {
		status.code += `add sp, sp, #${total_stack}\n`;
	}
	status.code = patch_overflow_placeholders(
		status.code,
		node.name,
		callee_idx + loop_regs_used.length,
		total_stack,
	);

	for (let i = loop_regs_used.length - 1; i >= 0; i--) {
		status.code += `ldr ${loop_regs_used[i]}, [sp], #16\n`;
	}

	for (let ci = callee_idx - 1; ci >= 0; ci--) {
		status.code += `ldr ${callee_saved[ci]}, [sp], #16\n`;
	}

	if (init_struct_size > 0) {
		status.code += `add sp, sp, #${init_struct_size}\n`;
	}

	status.code += `ldp x29, x30, [sp], #16\n`;
	status.code += `ret\n`;

	status.code = peephole_optimize(status.code);

	if (is_nested) {
		if (status.function_data) {
			status.code += status.function_data;
			status.function_data = undefined;
		}
		if (!status.nested_functions) status.nested_functions = "";
		status.nested_functions += status.code;
		status.code = old_code!;
	}

	if (status.function_data) {
		status.code += status.function_data;
		status.function_data = undefined;
	}
	if (status.nested_functions && !is_nested) {
		status.code += status.nested_functions;
		status.nested_functions = undefined;
	}

	status.scoped_declarations = old_scoped_declarations;
	status.moved = old_moved;
	status.current_function_name = old_function_name;
	status.stack_size = old_stack_size;
	status.stack_offsets = old_stack_offsets;
	status.function_param_regs = old_function_param_regs;
	status.function_param_vars = old_function_param_vars;
	status.function_array_params = old_function_array_params;
	status.function_ref_params = old_function_ref_params;
	status.ref_class_slots = old_ref_class_slots;
	status.function_variadic_params = old_variadic_params_aarch64;
	status.function_return_label = old_return_label;
	status.struct_return_buffer = undefined;
	status.return_buffer_stack_offset = undefined;
	status.function_return_type = undefined;
}
