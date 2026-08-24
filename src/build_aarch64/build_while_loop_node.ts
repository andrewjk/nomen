import type BuildStatus from "../build_c/BuildStatus.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import { enter_scope_frame, exit_scope_frame } from "./utils/auto_destroy.ts";
import collect_var_refs, { collect_declared_names } from "./utils/collect_var_refs.ts";

const CALLEE_SAVED_REGS = ["x23", "x24", "x25", "x26", "x27", "x28"];
const FLOAT_CALLEE_SAVED = ["d8", "d9", "d10", "d11", "d12", "d13", "d14", "d15"];
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
const FLOAT_TYPES = new Set(["float", "ufloat", "float32", "ufloat32", "float64", "ufloat64"]);

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_while_loop_node(node: WhileLoopNode, status: BuildStatus) {
	const old_scoped_declarations = enter_scope_frame(status);

	const label = label_counter++;
	const start_label = `.while_${label}`;
	const end_label = `.end_while_${label}`;
	const continue_label = node.update ? `.while_update_${label}` : start_label;

	status.loop_labels = status.loop_labels || [];
	const cleanup_depth = status.heap_cleanup_stack?.length ?? 0;
	status.loop_labels.push({ start: continue_label, end: end_label, cleanup_depth });

	const promoted: { name: string; reg: string; offset: number }[] = [];
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
					all_refs.set(name, { reads: info.reads, address_taken: info.address_taken });
				}
			}
		};

		merge_refs(collect_var_refs(node.condition));
		for (const stmt of node.statements) {
			merge_refs(collect_var_refs(stmt));
		}
		if (node.update) {
			merge_refs(collect_var_refs(node.update));
		}

		const eligible: { name: string; reads: number; offset: number; type_name: string }[] = [];
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
				if (!SCALAR_TYPES.has(type_name)) continue;
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
		// clobber the outer loop's value across this loop's body.
		if (status.callee_saved_regs_used) {
			for (const r of status.callee_saved_regs_used) used_x.add(r);
		}
		let x_idx = 0;
		let d_idx = 0;
		for (const v of eligible) {
			const is_float = FLOAT_TYPES.has(v.type_name);
			if (is_float) {
				while (d_idx < FLOAT_CALLEE_SAVED.length && used_d.has(FLOAT_CALLEE_SAVED[d_idx])) {
					d_idx++;
				}
				if (d_idx >= FLOAT_CALLEE_SAVED.length) continue;
				const reg = FLOAT_CALLEE_SAVED[d_idx];
				status.register_allocations.set(v.name, reg);
				used_d.add(reg);
				promoted.push({ name: v.name, reg, offset: v.offset });
				status.code += `ldr ${reg}, [x29, #${v.offset}]\n`;
				d_idx++;
			} else {
				while (x_idx < CALLEE_SAVED_REGS.length && used_x.has(CALLEE_SAVED_REGS[x_idx])) {
					x_idx++;
				}
				if (x_idx >= CALLEE_SAVED_REGS.length) continue;
				const reg = CALLEE_SAVED_REGS[x_idx];
				status.register_allocations.set(v.name, reg);
				used_x.add(reg);
				promoted.push({ name: v.name, reg, offset: v.offset });
				status.code += `ldr ${reg}, [x29, #${v.offset}]\n`;
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

	// (String `.length` is a load of the fat string's len half — no
	// strlen hoisting is needed anymore.)

	status.code += `${start_label}:\n`;

	const is_always_true =
		node.condition.node_type === "value" && (node.condition as any).value === "true";

	if (!is_always_true) {
		build_node(node.condition, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `cmp x0, #0\n`;
		status.code += `beq ${end_label}\n`;
	}

	build_block_node(node, status);

	if (node.update) {
		status.code += `${continue_label}:\n`;
		build_node(node.update, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	status.code += `b ${start_label}\n`;
	status.code += `${end_label}:\n`;

	for (const p of promoted) {
		status.code += `str ${p.reg}, [x29, #${p.offset}]\n`;
	}

	if (saved_reg_allocs) {
		status.register_allocations = saved_reg_allocs;
	} else {
		status.register_allocations = undefined;
	}

	status.buffer_data_cache = saved_buffer_cache;

	status.loop_labels.pop();
	exit_scope_frame(status, old_scoped_declarations);
}
