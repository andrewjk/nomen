import { get_built_in_type } from "../built_in_types.ts";
import type AccessFieldNode from "../nodes/AccessFieldNode.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type AccessNode from "../nodes/AccessNode.ts";
import type ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type CastNode from "../nodes/CastNode.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type IfElseNode from "../nodes/IfElseNode.ts";
import type OperationNode from "../nodes/OperationNode.ts";
import type RangeNode from "../nodes/RangeNode.ts";
import type Type from "../nodes/Type.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import type BuildStatus from "./BuildStatus.ts";

/**
 * The checker stamps a `Type` on every expression node; the JS backend reads
 * it back without a CheckStatus (mirrors check/utils/type_from_value_node).
 */
export function stamped_type(node: BaseNode | undefined): Type | undefined {
	if (!node) return undefined;
	switch (node.node_type) {
		case "value":
			return (node as ValueNode).type;
		case "op":
			return (node as OperationNode).type;
		case "func_call":
			return (node as FunctionCallNode).type;
		case "access":
			return stamped_type((node as AccessNode).access);
		case "access_func":
			return (node as AccessFunctionCallNode).type;
		case "access_field":
			return (node as AccessFieldNode).type;
		case "cast":
			return (node as CastNode).target_type;
		case "if":
			return (node as IfElseNode).return_type;
		case "array":
			return (node as ArrayValuesNode).type;
		case "range":
			return (node as RangeNode).type;
		default:
			return undefined;
	}
}

export function type_name_of(node: BaseNode | undefined): string {
	return stamped_type(node)?.name ?? "";
}

export type ValueKind = "int" | "float" | "bool" | "char" | "string" | "array" | "other";

/** The runtime representation family of an expression: JS `bigint` for every
 *  int family, `number` for floats, `string` for strings/chars (a char is a
 *  one-character string), `boolean` for bools, and a JS array for arrays. */
export function kind_of(node: BaseNode | undefined): ValueKind {
	const t = stamped_type(node);
	if (!t) return "other";
	if (t.is_array) return "array";
	// A `view` slice is a borrowed array except for string/char views (a JS
	// string is the representation for both).
	if (t.is_view) return t.name === "string" || t.name === "char" ? "string" : "array";
	const info = get_built_in_type(t.name);
	switch (info?.kind) {
		case "int":
			return "int";
		case "float":
			return "float";
		case "bool":
			return "bool";
		case "char":
			return "char";
		case "string":
			return "string";
		default:
			return "other";
	}
}

export function is_int_kind(node: BaseNode | undefined): boolean {
	return kind_of(node) === "int";
}

export function is_float_kind(node: BaseNode | undefined): boolean {
	return kind_of(node) === "float";
}

/** True when `name` is a user `struct` with value semantics (non-`mv`), so
 *  binding/assigning it copies the fields (MEMORY.md: "Assigning a struct
 *  creates an independent copy"). `mv`/owning structs move instead. */
export function is_value_struct(name: string | undefined, status: BuildStatus): boolean {
	if (!name) return false;
	const struct = status.structs.find((s) => s.name === name);
	return !!struct && !struct.is_owning && !struct.is_class;
}

/** Wrap an emitted struct value in a deep copy when its type has value
 *  semantics; identity otherwise. */
export function copy_if_value_struct(
	value: string,
	type_name: string | undefined,
	status: BuildStatus,
): string {
	return is_value_struct(type_name, status) ? `__copy(${value})` : value;
}
