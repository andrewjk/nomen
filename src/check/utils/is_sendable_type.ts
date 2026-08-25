import { is_scalar_type } from "../../built_in_types.ts";
import type CheckStatus from "../CheckStatus.ts";

/**
 * Is this type safe to move across a task boundary?
 *
 * Rules:
 * - Scalar primitives (ints, floats, bool, char) and string are always
 *   Sendable.
 * - Arrays of Sendable element types are Sendable.
 * - Structs are Sendable if EITHER explicitly marked `: Sendable` OR all their
 *   fields are Sendable (auto-derive). Auto-derive is recursive; cycles are
 *   guarded by `visited`.
 * - Classes must explicitly declare `: Sendable` (they're mutable shared
 *   references — auto-derive would be unsafe by default).
 *
 * See ASYNC.md.
 */
export default function is_sendable_type(
	type_name: string | undefined,
	status: CheckStatus,
	visited: Set<string> = new Set(),
): boolean {
	if (!type_name) return false;
	if (is_scalar_type(type_name) || type_name === "string") return true;
	// Array types are named like "Array_<elem>" or "Array".
	if (type_name.startsWith("Array_") || type_name === "Array") return true;
	const struct = status.structs.find((s) => s.name === type_name);
	if (!struct) return false;
	if (struct.traits.includes("Sendable")) return true;
	// Classes don't auto-derive — they must opt in explicitly.
	if (struct.is_class) return false;
	// Auto-derive for structs: check every field's type recursively.
	if (visited.has(type_name)) return false; // recursive cycle — be safe
	visited.add(type_name);
	return struct.fields.every((f) => is_sendable_type(f.type.name, status, visited));
}
