import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import collect_var_refs from "./utils/collect_var_refs.ts";
import {
	allocate_stack_space,
	emit_var_address,
	emit_var_load,
	emit_var_store,
} from "./utils/stack_var.ts";
import { get_struct_size } from "./utils/struct_layout.ts";

const CALLEE_SAVED_REGS = ["x23", "x24", "x25", "x26", "x27", "x28"];
const SCALAR_TYPES = new Set([
	"int",
	"uint",
	"int64",
	"uint64",
	"int32",
	"uint32",
	"int16",
	"uint16",
	"int8",
	"uint8",
	"bool",
	"char",
	"float",
	"ufloat",
	"float32",
	"ufloat32",
	"float64",
	"ufloat64",
]);

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_for_loop_node(node: ForLoopNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];

	const label = label_counter++;
	const item_name = node.item.value;
	const start_label = `.for_${label}`;
	const end_label = `.end_${label}`;
	const increment_label = `.for_inc_${label}`;
	const continue_label = node.update ? `.for_update_${label}` : increment_label;

	status.loop_labels = status.loop_labels || [];
	const cleanup_depth = status.heap_cleanup_stack?.length ?? 0;
	status.loop_labels.push({ start: continue_label, end: end_label, cleanup_depth });

	if (status.function_return_label) {
		const item_offset = allocate_stack_space(status, 8);
		status.stack_offsets!.set(item_name, item_offset);
	}

	const promoted: { name: string; reg: string; offset: number }[] = [];
	const saved_reg_allocs = status.register_allocations
		? new Map(status.register_allocations)
		: undefined;

	if (status.function_return_label && node.statements.length > 0) {
		const all_refs = new Map<string, { reads: number; address_taken: boolean }>();
		const merge_refs = (refs: Map<string, { reads: number; address_taken: boolean }>) => {
			for (const [name, info] of refs) {
				const existing = all_refs.get(name);
				if (existing) {
					existing.reads += info.reads;
					if (info.address_taken) existing.address_taken = true;
				} else {
					all_refs.set(name, { reads: info.reads, address_taken: info.address_taken });
				}
			}
		};
		for (const stmt of node.statements) {
			merge_refs(collect_var_refs(stmt));
		}
		if (node.update) {
			merge_refs(collect_var_refs(node.update));
		}

		const eligible: { name: string; reads: number; offset: number }[] = [];
		for (const [name, info] of all_refs) {
			if (info.reads < 3) continue;
			if (info.address_taken) continue;
			const offset = status.stack_offsets?.get(name);
			if (offset === undefined) continue;
			if (status.register_allocations?.has(name)) continue;
			const decl = old_scoped_declarations.find((d) => d.name === name);
			if (decl) {
				const type_name = decl.type?.name || "";
				if (!SCALAR_TYPES.has(type_name)) continue;
			}
			eligible.push({ name, reads: info.reads, offset });
		}
		eligible.sort((a, b) => b.reads - a.reads);

		if (!status.register_allocations) {
			status.register_allocations = new Map();
		}

		const used_regs = new Set(status.register_allocations.values());
		let reg_idx = 0;
		for (const v of eligible) {
			while (reg_idx < CALLEE_SAVED_REGS.length && used_regs.has(CALLEE_SAVED_REGS[reg_idx])) {
				reg_idx++;
			}
			if (reg_idx >= CALLEE_SAVED_REGS.length) break;
			const reg = CALLEE_SAVED_REGS[reg_idx];
			status.register_allocations.set(v.name, reg);
			used_regs.add(reg);
			promoted.push({ name: v.name, reg, offset: v.offset });
			status.code += `ldr ${reg}, [x29, #${v.offset}]\n`;
			reg_idx++;
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

		status.code += `ldr x0, =0\n`;
		emit_var_store(status, "x0", idx_name, 8);

		status.code += `${start_label}:\n`;

		emit_var_load(status, "x0", idx_name, 8);
		status.code += `mov x2, x0\n`;
		status.code += `ldr x0, =${length}\n`;
		status.code += `cmp x2, x0\n`;
		status.code += `bge ${end_label}\n`;

		const list_name = node.list.node_type === "value" ? (node.list as any).value : "_list";
		const list_type = type_from_value_node(node.list);
		const list_is_pointer =
			list_type.is_array &&
			(!!status.function_array_params?.has(list_name) || !!status.heap_array_vars?.has(list_name));
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

		build_block_node(node, status);

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
		status.code += `str ${p.reg}, [x29, #${p.offset}]\n`;
	}

	if (saved_reg_allocs) {
		status.register_allocations = saved_reg_allocs;
	} else {
		status.register_allocations = undefined;
	}

	status.loop_labels.pop();
	status.scoped_declarations = old_scoped_declarations;
}
