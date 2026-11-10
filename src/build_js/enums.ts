import type EnumNode from "../nodes/EnumNode.ts";

/**
 * Enum values are plain JS objects: `{ $tag: n, <param>: value, … }`, where
 * `$tag` is the case index (the enum's declaration order, matching the C
 * backend's tag) and the payload fields are keyed by the ENUM's parameter
 * names (a match-site binding is positional — `.ok(x)` binds `x` to the
 * first payload field whatever the enum named it).
 */

/** Resolve the checker's flattened `Enum_case` name (`Res_ok`) to its enum
 *  and case index. */
export function find_enum_case(
	enums: EnumNode[],
	value: string,
): { enum_node: EnumNode; case_index: number } | undefined {
	for (const enum_node of enums) {
		const prefix = `${enum_node.name}_`;
		if (!value.startsWith(prefix)) continue;
		const case_name = value.substring(prefix.length);
		const case_index = enum_node.cases.findIndex((c) => c.name === case_name);
		if (case_index !== -1) return { enum_node, case_index };
	}
	return undefined;
}

/** The JS object literal for a case construction with the given argument
 *  expressions. */
export function enum_case_value(enum_node: EnumNode, case_index: number, args: string[]): string {
	const case_def = enum_node.cases[case_index];
	const parts = [`$tag: ${case_index}`];
	case_def.params.forEach((param, i) => {
		if (args[i] !== undefined) parts.push(`${param.name}: ${args[i]}`);
	});
	return `({ ${parts.join(", ")} })`;
}
