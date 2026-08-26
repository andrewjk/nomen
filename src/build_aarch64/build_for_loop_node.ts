import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { ALL_FLOAT_TYPES, SCALAR_TYPES } from "../built_in_types.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { enter_scope_frame, exit_scope_frame } from "./utils/auto_destroy.ts";
import collect_var_refs, { collect_declared_names } from "./utils/collect_var_refs.ts";
import {
	allocate_stack_space,
	emit_promoted_load,
	emit_promoted_store,
	emit_var_address,
	emit_var_load,
	emit_var_store,
} from "./utils/stack_var.ts";
import { get_struct_size } from "./utils/struct_layout.ts";

const CALLEE_SAVED_REGS = ["x23", "x24", "x25", "x26", "x27", "x28"];
const FLOAT_CALLEE_SAVED = ["d8", "d9", "d10", "d11", "d12", "d13", "d14", "d15"];

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_for_loop_node(node: ForLoopNode, status: BuildStatus) {
	const old_scoped_declarations = enter_scope_frame(status);

	const label = label_counter++;
	const item_name = node.item.value;
	const start_label = `.for_${label}`;
	const end_label = `.end_${label}`;
	const increment_label = `.for_inc_${label}`;
	const continue_label = node.update ? `.for_update_${label}` : increment_label;

	status.loop_labels = status.loop_labels || [];
	const cleanup_depth = status.heap_cleanup_stack?.length ?? 0;
	status.loop_labels.push({
		start: continue_label,
		end: end_label,
		cleanup_depth,
	});
	if (!status.loop_writebacks) status.loop_writebacks = [];
	status.loop_writebacks.push(undefined);

	if (status.function_return_label) {
		const item_offset = allocate_stack_space(status, 8);
		status.stack_offsets!.set(item_name, item_offset);
	}

	const promoted: {
		name: string;
		reg: string;
		offset: number;
		type_name: string;
	}[] = [];
	const saved_reg_allocs = status.register_allocations
		? new Map(status.register_allocations)
		: undefined;
	const saved_buffer_cache = status.buffer_data_cache;
	status.buffer_data_cache = undefined;

	if (status.function_return_label && node.statements.length > 0) {
		const all_refs = new Map<string, { reads: number; address_taken: boolean }>();
		const merge_refs = (refs: Map<string, { reads: number; address_taken: boolean }>) => {
			for (const [name, info] of refs) {
				const existing = all_refs.get(name);
				if (existing) {
					existing.reads += info.reads;
					if (info.address_taken) existing.address_taken = true;
				} else {
					all_refs.set(name, {
						reads: info.reads,
						address_taken: info.address_taken,
					});
				}
			}
		};
		for (const stmt of node.statements) {
			merge_refs(collect_var_refs(stmt));
		}
		if (node.update) {
			merge_refs(collect_var_refs(node.update));
		}

		const eligible: {
			name: string;
			reads: number;
			offset: number;
			type_name: string;
		}[] = [];
		const redeclared = collect_declared_names({
			node_type: "block",
			statements: node.statements,
		} as any);
		for (const [name, info] of all_refs) {
			if (info.reads < 3) continue;
			if (info.address_taken) continue;
			if (redeclared.has(name)) continue;
			const offset = status.stack_offsets?.get(name);
			if (offset === undefined) continue;
			if (status.register_allocations?.has(name)) continue;
			const decl = old_scoped_declarations.find((d) => d.name === name);
			let type_name = "";
			if (decl) {
				type_name = decl.type?.name || "";
				if (!SCALAR_TYPES.includes(type_name)) continue;
			}
			eligible.push({ name, reads: info.reads, offset, type_name });
		}
		eligible.sort((a, b) => b.reads - a.reads);

		if (!status.register_allocations) {
			status.register_allocations = new Map();
		}

		const used_regs = new Set(status.register_allocations.values());
		const used_x = new Set<string>();
		const used_d = new Set<string>();
		for (const r of used_regs) {
			if (r.startsWith("d")) used_d.add(r);
			else used_x.add(r);
		}
		// Avoid callee-saved registers already claimed by an enclosing loop's
		// promoted variables or Buffer data-pointer caches — reusing one would
		// clobber the outer loop's value across this loop's body. Split by
		// register class so a claimed d-register actually blocks the float
		// pool (adding every name to used_x left d8-d15 claims invisible to
		// the FLOAT_CALLEE_SAVED scan).
		if (status.callee_saved_regs_used) {
			for (const r of status.callee_saved_regs_used) {
				if (r.startsWith("d")) used_d.add(r);
				else used_x.add(r);
			}
		}
		let x_idx = 0;
		let d_idx = 0;
		for (const v of eligible) {
			const is_float = ALL_FLOAT_TYPES.includes(v.type_name);
			if (is_float) {
				while (d_idx < FLOAT_CALLEE_SAVED.length && used_d.has(FLOAT_CALLEE_SAVED[d_idx])) {
					d_idx++;
				}
				if (d_idx >= FLOAT_CALLEE_SAVED.length) continue;
				const reg = FLOAT_CALLEE_SAVED[d_idx];
				status.register_allocations.set(v.name, reg);
				used_d.add(reg);
				promoted.push({
					name: v.name,
					reg,
					offset: v.offset,
					type_name: v.type_name,
				});
				// The cached register must be loaded with the slot's width —
				// bool/char/int8 slots are 1-byte strb stores, so a full-width
				// `ldr` would pull dirty stack bytes into the cache.
				emit_promoted_load(status, reg, v.offset, v.type_name);
				d_idx++;
			} else {
				while (x_idx < CALLEE_SAVED_REGS.length && used_x.has(CALLEE_SAVED_REGS[x_idx])) {
					x_idx++;
				}
				if (x_idx >= CALLEE_SAVED_REGS.length) continue;
				const reg = CALLEE_SAVED_REGS[x_idx];
				status.register_allocations.set(v.name, reg);
				used_x.add(reg);
				promoted.push({
					name: v.name,
					reg,
					offset: v.offset,
					type_name: v.type_name,
				});
				emit_promoted_load(status, reg, v.offset, v.type_name);
				x_idx++;
			}
		}

		if (promoted.length > 0) {
			if (!status.callee_saved_regs_used) {
				status.callee_saved_regs_used = new Set();
			}
			for (const p of promoted) {
				status.callee_saved_regs_used.add(p.reg);
			}
		}
	}

	if (node.list && node.list.node_type === "range") {
		const range = node.list as RangeNode;

		if (range.left_value) {
			build_node(range.left_value, status);
		} else {
			status.code += `ldr x0, =0`;
		}
		status.code += `\n`;
		emit_var_store(status, "x0", item_name, 8);

		status.code += `${start_label}:\n`;

		build_node(node.item, status);
		const right_is_literal = range.right_value?.node_type === "value";
		if (right_is_literal) {
			status.code += `\nmov x2, x0\n`;
			if (range.right_value) {
				build_node(range.right_value, status);
			} else {
				status.code += `ldr x0, =0`;
			}
			status.code += `\ncmp x2, x0\n`;
		} else {
			status.code += `\nstr x0, [sp, #-16]!\n`;
			if (range.right_value) {
				build_node(range.right_value, status);
			} else {
				status.code += `ldr x0, =0`;
			}
			status.code += `\nmov x2, x0\n`;
			status.code += `ldr x1, [sp], #16\n`;
			status.code += `cmp x1, x2\n`;
		}
		status.code += `bge ${end_label}\n`;

		build_block_node(node, status);

		if (node.update) {
			status.code += `${continue_label}:\n`;
			build_node(node.update, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}

		status.code += `${increment_label}:\n`;
		build_node(node.item, status);
		status.code += `\nadd x0, x0, #1\n`;
		emit_var_store(status, "x0", item_name, 8);

		status.code += `b ${start_label}\n`;
		status.code += `${end_label}:\n`;
	} else if (node.list && is_enumerable_type(node.list, status)) {
		// Enumerable type: call .length() and iterate 0..length
		const list_name = node.list.node_type === "value" ? (node.list as any).value : "_list";

		// Call container.length() to get upper bound
		status.code += `// call ${list_name}.length()\n`;
		emit_var_address(status, "x0", list_name);
		status.code += `str x0, [sp, #-16]!\n`;
		status.code += `bl ${list_name}_length\n`;
		status.code += `add sp, sp, #16\n`;
		// x0 now has length; store it in a temp
		const len_offset = allocate_stack_space(status, 8);
		status.code += `str x0, [x29, #${len_offset}]\n`;

		// Initialize index to 0
		status.code += `ldr x0, =0\n`;
		emit_var_store(status, "x0", item_name, 8);

		status.code += `${start_label}:\n`;

		// Load index
		emit_var_load(status, "x0", item_name, 8);
		// Load length
		status.code += `ldr x1, [x29, #${len_offset}]\n`;
		status.code += `cmp x0, x1\n`;
		status.code += `bge ${end_label}\n`;

		build_block_node(node, status);

		if (node.update) {
			status.code += `${continue_label}:\n`;
			build_node(node.update, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}

		status.code += `${increment_label}:\n`;
		emit_var_load(status, "x0", item_name, 8);
		status.code += `add x0, x0, #1\n`;
		emit_var_store(status, "x0", item_name, 8);

		status.code += `b ${start_label}\n`;
		status.code += `${end_label}:\n`;
	} else {
		const type = type_from_value_node(node.list);
		const length = type.length ? (type.length as any).value : "0";
		const struct_type = status.structs.find((s) => s.name === type.name && !s.is_simple_type);
		const element_size = struct_type
			? struct_type.is_class
				? 8
				: get_struct_size(type.name, status)
			: type.name
				? aarch64_size(type.name)
				: 8;
		const idx_name = `_idx_${item_name}`;

		if (struct_type && status.function_return_label) {
			const struct_size = element_size;
			const item_offset = allocate_stack_space(status, struct_size);
			status.stack_offsets!.set(item_name, item_offset);
		}

		if (status.function_return_label) {
			const idx_offset = allocate_stack_space(status, 8);
			status.stack_offsets!.set(idx_name, idx_offset);
		}

		const list_name = node.list.node_type === "value" ? (node.list as any).value : "_list";
		const list_type = type_from_value_node(node.list);
		const list_is_pointer =
			list_type.is_array &&
			(!!status.function_array_params?.has(list_name) || !!status.heap_array_vars?.has(list_name));

		// Dynamic-length arrays (heap-allocated via Array.with, or array params
		// whose length isn't known at compile time) need the runtime length from
		// the buffer prefix. When the type carries a compile-time length (e.g. a
		// fixed-size literal passed to a function), use that instead.
		let dyn_len_offset: number | undefined;
		if (status.function_return_label && list_is_pointer && !type.length) {
			dyn_len_offset = allocate_stack_space(status, 8);
			emit_var_load(status, "x0", list_name, 8);
			if (status.heap_array_vars?.has(list_name)) {
				status.code += `ldr x0, [x0]\n`;
			} else {
				status.code += `ldr x0, [x0, #-8]\n`;
			}
			status.code += `str x0, [x29, #${dyn_len_offset}]\n`;
		}

		status.code += `ldr x0, =0\n`;
		emit_var_store(status, "x0", idx_name, 8);

		status.code += `${start_label}:\n`;

		emit_var_load(status, "x0", idx_name, 8);
		status.code += `mov x2, x0\n`;
		if (dyn_len_offset !== undefined) {
			status.code += `ldr x0, [x29, #${dyn_len_offset}]\n`;
		} else {
			status.code += `ldr x0, =${length}\n`;
		}
		status.code += `cmp x2, x0\n`;
		status.code += `bge ${end_label}\n`;

		if (list_is_pointer) {
			emit_var_load(status, "x3", list_name, 8);
			if (status.heap_array_vars?.has(list_name)) {
				status.code += `add x3, x3, #8\n`;
			}
		} else {
			emit_var_address(status, "x3", list_name);
		}
		emit_var_load(status, "x1", idx_name, 8);
		const shift = Math.log2(element_size);
		if (Number.isInteger(shift) && shift > 0) {
			status.code += `add x0, x3, x1, lsl #${shift}\n`;
		} else {
			status.code += `mov x2, #${element_size}\n`;
			status.code += `mul x1, x1, x2\n`;
			status.code += `add x0, x3, x1\n`;
		}
		if (struct_type) {
			const item_offset = status.stack_offsets!.get(item_name);
			if (item_offset !== undefined) {
				const words = Math.ceil(element_size / 8);
				for (let w = 0; w < words; w++) {
					status.code += `ldr x1, [x0, #${w * 8}]\n`;
					status.code += `str x1, [x29, #${item_offset + w * 8}]\n`;
				}
			}
		} else {
			if (element_size === 1) {
				status.code += `ldrb w0, [x0]\n`;
			} else if (element_size === 4) {
				status.code += `ldr w0, [x0]\n`;
			} else {
				status.code += `ldr x0, [x0]\n`;
			}
			emit_var_store(status, "x0", item_name, element_size);
		}

		// For `for ref x of arr`, create a write-back that recomputes the
		// element address and stores the (possibly mutated) item back. Called
		// after the body and before break/continue.
		if (node.item_is_ref) {
			const wb_struct_type = struct_type;
			const wb_element_size = element_size;
			const wb_item_name = item_name;
			const wb_idx_name = idx_name;
			const wb_list_name = list_name;
			const wb_list_is_pointer = list_is_pointer;
			const wb_shift = shift;
			status.loop_writebacks![status.loop_writebacks.length - 1] = () => {
				// Recompute element address into x9.
				if (wb_list_is_pointer) {
					emit_var_load(status, "x9", wb_list_name, 8);
					if (status.heap_array_vars?.has(wb_list_name)) {
						status.code += `add x9, x9, #8\n`;
					}
				} else {
					emit_var_address(status, "x9", wb_list_name);
				}
				emit_var_load(status, "x10", wb_idx_name, 8);
				if (Number.isInteger(wb_shift) && wb_shift > 0) {
					status.code += `add x9, x9, x10, lsl #${wb_shift}\n`;
				} else {
					status.code += `mov x11, #${wb_element_size}\n`;
					status.code += `mul x10, x10, x11\n`;
					status.code += `add x9, x9, x10\n`;
				}
				if (wb_struct_type) {
					const item_offset = status.stack_offsets!.get(wb_item_name);
					if (item_offset !== undefined) {
						const words = Math.ceil(wb_element_size / 8);
						for (let w = 0; w < words; w++) {
							status.code += `ldr x10, [x29, #${item_offset + w * 8}]\n`;
							status.code += `str x10, [x9, #${w * 8}]\n`;
						}
					}
				} else {
					if (wb_element_size === 1) {
						emit_var_load(status, "x10", wb_item_name, wb_element_size);
						status.code += `strb w10, [x9]\n`;
					} else if (wb_element_size === 4) {
						emit_var_load(status, "x10", wb_item_name, wb_element_size);
						status.code += `str w10, [x9]\n`;
					} else {
						emit_var_load(status, "x10", wb_item_name, wb_element_size);
						status.code += `str x10, [x9]\n`;
					}
				}
			};
		}

		build_block_node(node, status);

		// Write the (possibly mutated) loop variable back into its array slot.
		status.loop_writebacks![status.loop_writebacks.length - 1]?.();

		if (node.update) {
			status.code += `${continue_label}:\n`;
			build_node(node.update, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}

		status.code += `${increment_label}:\n`;
		emit_var_load(status, "x0", idx_name, 8);
		status.code += `add x0, x0, #1\n`;
		emit_var_store(status, "x0", idx_name, 8);

		status.code += `b ${start_label}\n`;
		status.code += `${end_label}:\n`;
	}

	for (const p of promoted) {
		// Store back with the slot's width — a full-width `str` into a
		// sub-word slot would clobber the adjacent stack bytes.
		emit_promoted_store(status, p.reg, p.offset, p.type_name);
	}

	if (saved_reg_allocs) {
		status.register_allocations = saved_reg_allocs;
	} else {
		status.register_allocations = undefined;
	}

	status.buffer_data_cache = saved_buffer_cache;
	status.loop_labels.pop();
	status.loop_writebacks?.pop();
	exit_scope_frame(status, old_scoped_declarations);
}

function is_enumerable_type(node: any, status: BuildStatus): boolean {
	if (node.node_type !== "value") return false;
	const type_name = node.value;
	const struct = status.structs.find((s) => s.name === type_name);
	if (!struct) return false;
	return struct.traits.includes("Enumerable");
}
