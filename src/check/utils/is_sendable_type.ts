import type CheckStatus from "../CheckStatus.ts";

const PRIMITIVE_SENDABLE = new Set([
	"int",
	"uint",
	"int8",
	"uint8",
	"int16",
	"uint16",
	"int32",
	"uint32",
	"int64",
	"uint64",
	"float",
	"float32",
	"float64",
	"bool",
	"char",
	"string",
]);

/**
 * Is this type safe to move across a task boundary?
 *
 * Rules:
 * - Primitives (int/uint/float/bool/char/string) are always Sendable.
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
	if (PRIMITIVE_SENDABLE.has(type_name)) return true;
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
