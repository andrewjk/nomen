import { get_built_in_type } from "../built_in_types.ts";
import type CastNode from "../nodes/CastNode.ts";
import { expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { kind_of } from "./types.ts";

/** Emit a JS expression for an `as` cast between the numeric/bool/char
 *  families. Sized int targets wrap with BigInt.asIntN/asUintN, matching the
 *  C backend's truncation. */
export default function build_cast_node(node: CastNode, status: BuildStatus): string {
	const value = expr(node.value, status);
	const from = kind_of(node.value);
	const to = kind_of(node);
	const target = node.target_type;

	if (from === to) return value;

	if (to === "float") return `Number(${value})`;
	if (to === "int" && from === "float") return `BigInt(Math.trunc(${value}))`;
	if (to === "int" && from === "char") return `BigInt(${value}.charCodeAt(0))`;
	if (to === "int" && from === "bool") return `(${value} ? 1n : 0n)`;
	if (to === "bool" && from === "int") return `(${value} !== 0n)`;
	if (to === "char" && from === "int") return `String.fromCharCode(Number(${value}))`;
	if (to === "char" && from === "bool") return `(${value} ? "\\x01" : "\\x00")`;
	if (to === "string" && from !== "string") return `__to_string(${value})`;

	if (to === "int" && from === "int") {
		const info = get_built_in_type(target.name);
		const bits = info?.bits ?? 64;
		if (bits >= 64) return value;
		return info?.signed ? `BigInt.asIntN(${bits}, ${value})` : `BigInt.asUintN(${bits}, ${value})`;
	}

	// Same-family no-ops (e.g. int32 → int, float32 → float) already returned
	// above; anything else is outside the JS subset.
	return value;
}
