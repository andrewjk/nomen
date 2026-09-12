import built_in_types from "./built_in_types.ts";
import check_node from "./check/check_node.ts";
import type CheckStatus from "./check/CheckStatus.ts";
import emit_warnings from "./check/warnings.ts";
import BaseNode from "./nodes/BaseNode.ts";
import type CheckResult from "./types/CheckResult.ts";

export default function check(root: BaseNode): CheckResult {
	const status: CheckStatus = {
		stack: [root],
		scope_depth: 0,
		values: [],
		function_value_base: 0,
		types: [...built_in_types],
		structs: [],
		enums: [],
		bitsets: [],
		traits: [],
		functions: [],
		allocations: [],
		var_name_counter: { value: 0 },
		type_params: [],
		errors: [],
		warnings: [],
		buffer_caps: new Map(),
		mutated_local_names: new Set(),
		function_emission_names: new Set(),
	};

	check_node(root, status);

	// (The hidden string-length companion pass is retired: `.length` is a
	// field load on the fat string value, so no length threading is needed.)

	// Unsafe blocks are a checker-level scope only. Once checking is done,
	// splice their statements into the enclosing list so every downstream
	// consumer (NIR lowering, both backends' statement iteration, which pair
	// AST and NIR statements by index) sees a flat list — the wrapper would
	// otherwise desynchronize those pairings.
	unwrap_unsafe_blocks(root);

	// Only analyse for warnings on a clean check — a partially-checked,
	// erroring tree would surface misleading or spurious warnings.
	if (!status.errors.length) emit_warnings(root, status);

	return {
		ok: !status.errors.length,
		errors: status.errors,
		warnings: status.warnings ?? [],
	};
}

/**
 * Splice `unsafe { ... }` blocks out of every statement list, recursively.
 * The wrapper is a pure checker-level scope (it only raises `in_unsafe`
 * while its children are checked), so after checking it can be flattened —
 * inner statements keep their checker stamps and take the wrapper's place.
 */
function unwrap_unsafe_blocks(node: unknown): void {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) unwrap_unsafe_blocks(child);
		return;
	}
	const any_node = node as Record<string, unknown>;
	if (Array.isArray(any_node.statements)) {
		const list = any_node.statements as BaseNode[];
		for (let i = list.length - 1; i >= 0; i--) {
			const child = list[i] as BaseNode | undefined;
			// Recurse first so nested statement lists (if branches, loop
			// bodies, inner unsafe blocks) are already flat when we splice.
			unwrap_unsafe_blocks(child);
			if (!child || typeof child !== "object" || child.node_type !== "unsafe") continue;
			const inner = (child as unknown as { statements: BaseNode[] }).statements ?? [];
			list.splice(i, 1, ...inner);
		}
	}
	for (const key of Object.keys(node)) {
		if (key === "parent" || key === "scope" || key === "statements") continue;
		const value = any_node[key];
		if (value && typeof value === "object") unwrap_unsafe_blocks(value);
	}
}
