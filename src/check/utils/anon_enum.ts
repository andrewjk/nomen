import EnumNode from "../../nodes/EnumNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import RootNode from "../../nodes/RootNode.ts";
import Type from "../../nodes/Type.ts";
import { flatten_nested_generic_arg } from "../check_function_call_node.ts";
import type CheckStatus from "../CheckStatus.ts";
import { clone_type, materialize_tuple_type, sanitize_type_name } from "./tuple_struct.ts";

export interface AnonEnumCase {
	name: string;
	types: Type[];
}

/**
 * Canonical, order-independent name for an auto-generated anonymous enum
 * with the given cases. Cases are sorted by name so that
 * `[.ok(int), .error]` and `[.error, .ok(int)]` produce the same type
 * (structural identity, mirroring anonymous structs). Because the generated
 * enum's declaration order IS the sorted order, tag values are deterministic
 * for every literal sharing the type.
 */
export function anon_enum_name(cases: AnonEnumCase[]): string {
	const sorted = [...cases].sort((a, b) => a.name.localeCompare(b.name));
	return (
		"_AnonEnum_" +
		sorted.map((c) => [c.name, ...c.types.map(sanitize_type_name)].join("_")).join("__")
	);
}

/**
 * Whether a payload type (recursively through type args, tuple elements, and
 * nested anon enum payloads) references a type parameter of the enclosing
 * generic context. Such a type can't be materialized yet; the enclosing
 * generic's own monomorphization substitutes it later.
 */
function contains_unresolved_param(t: Type, status: CheckStatus): boolean {
	if (status.type_params.includes(t.name)) return true;
	if (t.type_args?.some((a) => contains_unresolved_param(a, status))) return true;
	if (t.tuple_types?.some((a) => contains_unresolved_param(a, status))) return true;
	if (t.enum_cases?.some((c) => c.types.some((a) => contains_unresolved_param(a, status)))) {
		return true;
	}
	return false;
}

/**
 * Materialize a parsed anonymous enum case list into an auto-generated enum,
 * returning the enum node. Payload types are made concrete first: nested
 * tuples and anonymous enums materialize to their generated structs/enums,
 * and generic payloads (`List<int>`) flatten to their monomorphized names,
 * so the generated enum's case params always reference emitted types.
 * Reuses an existing enum if one with the same cases was already created.
 * Returns null when a payload references an unresolved type parameter of an
 * enclosing generic (deferred, mirroring struct monomorphization).
 */
export function get_or_create_anon_enum(
	cases: AnonEnumCase[],
	status: CheckStatus,
): EnumNode | null {
	if (cases.some((c) => c.types.some((t) => contains_unresolved_param(t, status)))) {
		return null;
	}

	const sorted = [...cases].sort((a, b) => a.name.localeCompare(b.name));
	const name = anon_enum_name(sorted);
	const root = status.stack[0] as RootNode | undefined;
	const existing = status.enums.find((e) => e.name === name);
	if (existing) return existing;
	// The same anonymous enum may already have been materialized from a
	// different (cloned) check scope whose status.enums copy we don't share;
	// root.statements is the shared registry, so dedup against it too.
	const root_existing = root?.statements.find(
		(s) => s.node_type === "enum" && (s as EnumNode).name === name,
	) as EnumNode | undefined;
	if (root_existing) {
		status.enums.push(root_existing);
		return root_existing;
	}

	// Payload types must be concrete so the generated enum references emitted
	// types: nested tuples / anonymous enums materialize to their generated
	// types, and generic payloads (`List<int>`) flatten to their
	// monomorphized names (`List_int` — the same string `sanitize_type_name`
	// derives, so dedup is unaffected).
	const payload_type = (t: Type): Type => {
		if (t.name === "tuple" && t.tuple_types?.length) {
			return materialize_tuple_type(t, status);
		}
		if (t.name === "anon_enum" && t.enum_cases?.length) {
			return materialize_anon_enum_type(t, status);
		}
		if (t.type_args?.length) {
			return flatten_nested_generic_arg(t, status);
		}
		return t;
	};

	const node = new EnumNode(
		0,
		"private",
		name,
		sorted.map((c) => ({
			name: c.name,
			params: c.types.map((t, i) => new ParameterNode(0, `value${i}`, clone_type(payload_type(t)))),
		})),
	);

	status.enums.push(node);
	if (!status.types.includes(name)) {
		status.types.push(name);
	}

	// Register with root so the build phase emits the enum.
	if (root) {
		root.statements.push(node);
	}

	return node;
}

/**
 * Convert an anonymous enum Type (name === "anon_enum") into its materialized
 * enum Type. Returns a new Type whose name is the auto-generated enum name,
 * preserving `enum_cases` for rendering (mirroring how materialized tuples
 * keep `tuple_types`). Returns the type unchanged when a payload references
 * an unresolved type parameter (deferred until the enclosing generic is
 * monomorphized).
 */
export function materialize_anon_enum_type(type: Type, status: CheckStatus): Type {
	if (type.name !== "anon_enum" || !type.enum_cases?.length) return type;
	const node = get_or_create_anon_enum(type.enum_cases, status);
	if (!node) return type;
	const new_type = new Type(node.name);
	new_type.is_nullable = type.is_nullable;
	new_type.is_array = type.is_array;
	new_type.is_ref = type.is_ref;
	new_type.enum_cases = type.enum_cases;
	return new_type;
}
