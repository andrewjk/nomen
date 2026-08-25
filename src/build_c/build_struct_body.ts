import { mono_type_name } from "../build_common/mono_name.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import Type from "../nodes/Type.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type, { c_typedef_name } from "./utils/c_type.ts";
import is_system_definition from "./utils/is_system_definition.ts";
import { has_flag_name, is_nullable_struct_type } from "./utils/nullable_struct.ts";

export default function build_struct_body(node: StructNode, status: BuildStatus) {
	if (node.is_generic) return;
	if (node.is_simple_type) return;
	if (status.emitted_struct_bodies?.has(node.name)) return;
	// Central origin guard for the TU split. Every emission path into a struct
	// typedef — the pass-1 loop, the embedded-dependency recursion, and the
	// by-value-return buffer-swap in build_struct_node — funnels through here,
	// so a single check keeps a System typedef out of the user TU (and vice
	// versa). System typedefs live in system.h, which the user TU `#include`s,
	// so skipping here doesn't starve the user TU of the type.
	if (
		status.emit_mode === "user" &&
		is_system_definition(node, status.structs, status.system_struct_names)
	)
		return;
	if (
		status.emit_mode === "system" &&
		!is_system_definition(node, status.structs, status.system_struct_names)
	)
		return;
	status.emitted_struct_bodies?.add(node.name);

	// A struct that embeds another value struct by value (e.g. `Outer { Inner
	// inner }`) needs the embedded struct's full typedef to appear BEFORE its
	// own, wherever this body is emitted. When this body is emitted to the
	// HEADER on demand (a method returns it by value → build_struct_node
	// buffer-swaps status.code to status.headers), the embedded struct must be
	// pulled into the HEADER too — otherwise the header holds `struct Outer {
	// struct Inner inner; }` with `Inner` only forward-declared, which is an
	// incomplete type. Recursing BEFORE opening this typedef (idempotent via
	// emitted_struct_bodies) emits the dependency to the current buffer first.
	for (let field of node.fields) {
		const dep = embedded_value_struct(field.type, status);
		if (dep) build_struct_body(dep, status);
	}

	// Emit the struct typedef (body only, no functions). The struct TAG
	// (`struct Foo`) stays the plain Nomen name (raw #arch blocks and field
	// layouts reference it); only the TYPEDEF name is mangled when a GUI build
	// pulls in MacTypes.h (see set_c_typedef_mangling).
	status.code += `typedef struct ${node.name}\n{\n`;
	status.code += `void *_vt;\n`;
	// Fields from the struct
	for (let field of node.fields) {
		if (field.type.is_array && field.type.length && !field.type.is_array_heap) {
			// Fixed-size stack array field: e.g. char* items[2]
			status.code += `${field_c_type(field.type, status)} ${field.name}[`;
			if (field.type.length) {
				build_node(field.type.length, status);
			}
			status.code += `];\n`;
		} else {
			status.code += `${field_c_type(field.type, status)} ${field.name};\n`;
			// A nullable struct value field gets a companion `<field>_has` flag.
			if (is_nullable_struct_type(field.type, status)) {
				status.code += `unsigned char ${has_flag_name(field.name)};\n`;
			}
		}
	}
	// Default fields from traits
	for (let traitName of node.traits) {
		const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
		if (trait) {
			for (let field of trait.fields.filter((f) => !node.fields.find((nf) => nf.name === f.name))) {
				status.code += `${field_c_type(field.type, status)} ${field.name};\n`;
			}
		}
	}
	status.code += `} ${c_typedef_name(node.name)};\n`;
}

function field_c_type(type: Type, status: BuildStatus): string {
	// A `view T` field is the universal non-owning (ptr, len) slice struct —
	// every view lowers to the same 16-byte nomen_view value regardless of
	// its element type (mirrors the param/local emission sites).
	if (type.is_view) {
		return "nomen_view";
	}
	// A heap `Array<T>` field is a `struct Array_<T>*` pointer (the value
	// owns a heap buffer with a length header), not a `char*` element pointer
	// or an inline stack array.
	if (type.is_array_heap) {
		return `struct Array_${type.name} *`;
	}
	// Monomorphize generic field types: `List<Animal>` → `List_Animal`.
	const mono_name = mono_type_name(type);
	// Non-simple struct types must use the `struct` tag (the typedef may not
	// be in scope yet, e.g. forward references between monomorphized structs).
	const struct_node = status.structs.find(
		(s) => s.name === mono_name && !s.is_simple_type && !s.is_generic,
	);
	if (struct_node) {
		// Class-typed fields are heap pointers, not embedded structs.
		return struct_node.is_class ? `struct ${mono_name} *` : `struct ${mono_name}`;
	}
	return c_type(type.name);
}

/**
 * If `type` is a field type that embeds another value struct BY VALUE (not a
 * class pointer, not an array, not a primitive), return that struct so its
 * typedef can be emitted before the containing struct's. Used to keep struct
 * bodies self-ordering (and to pull embedded structs into the header when the
 * containing struct is emitted there on demand). Returns undefined for class
 * fields (forward-declared pointers), array fields, generics, and primitives.
 */
function embedded_value_struct(type: Type, status: BuildStatus): StructNode | undefined {
	if (type.is_ref || type.is_array || type.is_view || type.is_array_heap) return undefined;
	const mono_name = mono_type_name(type);
	const s = status.structs.find((n) => n.name === mono_name && !n.is_simple_type && !n.is_generic);
	if (!s || s.is_class) return undefined;
	return s;
}
