import type EnumNode from "../../nodes/EnumNode.ts";
import type CheckStatus from "../CheckStatus.ts";

/**
 * The registered generated enum behind a `T ! E` result mono, or undefined.
 * `T ! E` desugars to a checked enum stamped `template_name: "Result"`, so a
 * result value is any enum whose registered template says Result (unit
 * results stamp "UnitResult" and carry no success payload).
 */
export function find_result_enum(
	type_name: string | undefined,
	status: CheckStatus,
): EnumNode | undefined {
	if (!type_name) return undefined;
	const enum_node = status.enums.findLast((e) => e.name === type_name);
	return enum_node?.template_name === "Result" ? enum_node : undefined;
}

/**
 * A readable display name for a result type. Composed error sets render
 * their member enums (`Result<int, (A, B)>`) instead of leaking the
 * generated mono (`Result_int__AnonEnum_A_A__B_B`); simple results render
 * `Result<T, E>`. Undefined when the name is not a `T ! E` result.
 */
export function result_display_name(
	type_name: string | undefined,
	status: CheckStatus,
): string | undefined {
	const enum_node = find_result_enum(type_name, status);
	const ok = enum_node?.cases.find((c) => c.name === "ok");
	const fail = enum_node?.cases.find((c) => c.name === "fail");
	if (!ok?.params[0]?.type.name || !fail?.params[0]) return undefined;
	const success = ok.params[0].type.name;
	const error_type = fail.params[0].type;
	// A composed set's fail payload is the generated member-carrying enum
	// (`_AnonEnum_…`) — render the member names, not the synthesized name.
	const error_enum = status.enums.findLast((e) => e.name === error_type.name);
	if (error_enum && !error_enum.template_name && error_enum.name.startsWith("_AnonEnum_")) {
		const members = error_enum.cases
			.map((c) => c.params[0]?.type.name)
			.filter((n): n is string => !!n);
		if (members.length) {
			return `Result<${success}, (${members.join(", ")})>`;
		}
	}
	return `Result<${success}, ${error_type.name}>`;
}
