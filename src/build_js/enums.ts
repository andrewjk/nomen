import type EnumNode from "../nodes/EnumNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import { is_value_struct } from "./types.ts";

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
export function enum_case_value(
	enum_node: EnumNode,
	case_index: number,
	args: string[],
	status?: BuildStatus,
): string {
	const case_def = enum_node.cases[case_index];
	const parts = [`$tag: ${case_index}`];
	case_def.params.forEach((param, i) => {
		if (args[i] === undefined) return;
		// A payload is stored by value: a struct payload is copied (mutating
		// the donor afterwards must not change the enum).
		const copied =
			status && is_value_struct(param.type?.name, status) ? `__copy(${args[i]})` : args[i];
		parts.push(`${param.name}: ${copied}`);
	});
	return `({ ${parts.join(", ")} })`;
}
