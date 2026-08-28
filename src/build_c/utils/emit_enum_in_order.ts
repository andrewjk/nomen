import { mono_type_name } from "../../build_common/mono_name.ts";
import EnumNode from "../../nodes/EnumNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import TraitNode from "../../nodes/TraitNode.ts";
import Type from "../../nodes/Type.ts";
import build_bitset_node from "../build_bitset_node.ts";
import build_enum_node from "../build_enum_node.ts";
import build_struct_body from "../build_struct_body.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * Emit an enum's typedef, but first emit every type it embeds BY VALUE, in
 * dependency order.
 *
 * The C backend writes enum typedefs to the HEADER, and a tagged-union enum
 * (`has_associated_data`) embeds its case payloads as union members — so each
 * payload type's full definition must already appear in the header before the
 * enum's own typedef. Dependency-ordered emission matters because payload
 * types may live NESTED inside a function body (the test harness wraps
 * main-less input in `pub func main` via parse_with_imports, so every
 * user-declared type lands there): their typedefs are otherwise only emitted
 * when the enclosing function body is built (emit_nested_declarations), which
 * runs AFTER the root enum pass — so a monomorphized enum hoisted to root
 * scope (e.g. `Option<Color>` created by `Option.some(Color.red)` with both
 * enums declared inside main) would reference `Color` before its typedef
 * exists, failing clang with "unknown type name".
 *
 * Idempotent (build_enum_node's emitted_enums guard), so pulling a nested
 * enum forward never double-emits it when the enclosing body is built later.
 * Mirrors emit_struct_in_order's dependency handling for value structs.
 */
export default function emit_enum_in_order(node: EnumNode, status: BuildStatus) {
	if (node.is_generic) return;
	if (status.emitted_enums?.has(node.name)) return;
	for (const c of node.cases) {
		for (const p of c.params) {
			emit_by_value_dep(p.type, status);
		}
	}
	build_enum_node(node, status);
}

/**
 * Emit the definition of `type` when it is embedded by value as an enum case
 * payload: another enum (recursively, dependency-ordered), a bitset, or a
 * value struct. Refs/views/heap arrays are pointers (forward declarations
 * suffice), classes are pointer-typed, and generic templates have no concrete
 * layout — none impose ordering.
 */
function emit_by_value_dep(type: Type, status: BuildStatus): void {
	if (type.is_ref || type.is_view || type.is_array_heap) return;
	const name = mono_type_name(type);
	const dep_enum = status.enums.find((e) => e.name === name && !e.is_generic);
	if (dep_enum) {
		emit_enum_in_order(dep_enum, status);
		return;
	}
	const dep_bitset = status.bitsets.find((b) => b.name === name);
	if (dep_bitset) {
		build_bitset_node(dep_bitset, status);
		return;
	}
	const dep_struct = status.structs.find(
		(s) => s.name === name && !s.is_generic && !s.is_simple_type && !s.is_class,
	);
	if (dep_struct) {
		emit_struct_typedef_to_header(dep_struct, status);
	}
}

/**
 * Emit a value struct's typedef into the HEADER instead of its usual .m
 * position, because an enum typedef (header) embeds it by value and C needs
 * the complete type at that point. Idempotent via build_struct_body's
 * emitted_struct_bodies guard, which also makes the later struct-definition
 * pass skip the body (the .m sees it through the header include).
 *
 * Fields of enum type must precede this struct's typedef INSIDE the header,
 * so pull those first (idempotent via emitted_enums). Embedded value structs
 * recurse through build_struct_body into the same swapped header buffer.
 */
function emit_struct_typedef_to_header(struct: StructNode, status: BuildStatus): void {
	if (status.emitted_struct_bodies?.has(struct.name)) return;
	for (const field of struct.fields) {
		emit_struct_enum_field_dep(field.type, status);
	}
	for (const trait_name of struct.traits) {
		const trait = status.traits.find((t) => t.name === trait_name) as TraitNode | undefined;
		if (!trait) continue;
		for (const field of trait.fields) {
			emit_struct_enum_field_dep(field.type, status);
		}
	}
	const swap = status.code;
	status.code = status.headers;
	build_struct_body(struct, status);
	status.headers = status.code;
	status.code = swap;
}

/** Pull a struct field's enum-type dependency (header-internal ordering). */
function emit_struct_enum_field_dep(type: Type, status: BuildStatus): void {
	if (type.is_ref || type.is_view || type.is_array_heap) return;
	const name = mono_type_name(type);
	const dep_enum = status.enums.find((e) => e.name === name && !e.is_generic);
	if (dep_enum) {
		emit_enum_in_order(dep_enum, status);
	}
}
