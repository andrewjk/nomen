import { mono_type_name } from "../build_common/mono_name.ts";
import { is_nullable_scalar_type } from "../build_common/nullable_scalar.ts";
import { has_flag_name, is_nullable_struct_type } from "../build_common/nullable_struct.ts";
import { packed_own_fields, packed_trait_extra_fields } from "../build_common/struct_packing.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type, { c_typedef_name } from "./utils/c_type.ts";
import { emit_enum_deps_for_struct } from "./utils/emit_enum_in_order.ts";
import is_system_definition from "./utils/is_system_definition.ts";

export default function build_struct_body(node: StructNode, status: BuildStatus) {
	if (node.is_generic) return;
	if (node.is_simple_type) return;

	// A typedef can be needed in two different output streams — the `.m` code
	// body and the `.h` header. `status.code` is a plain string with no stable
	// identity, so the destination is threaded explicitly rather than inferred.
	// When emitting to the HEADER (a method returns the struct by value →
	// build_struct_node buffer-swaps status.code to status.headers), dedupe is
	// tracked in a separate, node-identity-keyed set so the header gets its own
	// full copy of this struct AND its embedded value-struct dependencies, even
	// when the same structs were already emitted to the code body.
	const to_header = status.struct_body_to_header === true;
	const code_emitted = status.emitted_struct_bodies;
	const header_emitted = (status.emitted_struct_header_bodies ??= new Set());

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

	if (to_header && header_emitted.has(node)) return;
	// The code path is name-keyed (it historically ran before monomorphized
	// node objects existed in `status.structs`).
	if (!to_header && code_emitted?.has(node.name)) return;

	if (to_header) {
		header_emitted.add(node);
	} else {
		code_emitted?.add(node.name);
	}
	// A header emission also records the code guard when requested, so the
	// later `.m` pass skips its own (would-be duplicate) copy.
	if (to_header && status.struct_body_header_mark_code_emitted) {
		code_emitted?.add(node.name);
	}

	// A struct that embeds another value struct by value (e.g. `Outer { Inner
	// inner }`) needs the embedded struct's full typedef to appear BEFORE its
	// own, wherever this body is emitted. When this body is emitted to the
	// HEADER on demand, the embedded struct must be pulled into the HEADER too —
	// otherwise the header holds `struct Outer { struct Inner inner; }` with
	// `Inner` only forward-declared, which is an incomplete type. Recursing
	// BEFORE opening this typedef emits the dependency to the current buffer
	// first (the destination flag stays set for the nested call).
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
	// Fields from the struct, in PACKED layout order — the same order the
	// aarch64 offset walk (`layout_fields`) and the check-side T_SIZE mirror
	// use, so C's naturally-aligned layout of these members places every
	// field at the offset the aarch64 backend computes. `struct.fields` keeps
	// declaration order (the positional #init contract); this is the layout
	// view only.
	const packed_fields = packed_own_fields(node);
	for (let field of packed_fields) {
		if (field.type.is_array && field.type.length && !field.type.is_array_heap) {
			// Fixed-size stack array field: e.g. char* items[2]
			status.code += `${field_c_type(field.type, status)} ${field.name}[`;
			if (field.type.length) {
				build_node(field.type.length, status);
			}
			status.code += `];\n`;
		} else {
			status.code += `${field_c_type(field.type, status)} ${field.name};\n`;
			// A nullable struct value field or nullable scalar field gets a
			// companion `<field>_has` flag.
			if (
				is_nullable_struct_type(field.type, status) ||
				is_nullable_scalar_type(field.type, status)
			) {
				status.code += `unsigned char ${has_flag_name(field.name)};\n`;
			}
		}
	}
	// Default fields from traits (packed among themselves, mirroring the
	// aarch64 layout_fields trait tail)
	for (let field of packed_trait_extra_fields(node, status.traits)) {
		status.code += `${field_c_type(field.type, status)} ${field.name};\n`;
	}
	status.code += `} ${c_typedef_name(node.name)};\n`;
}

/**
 * Run `build_struct_body` for `node`, forcing emission into the HEADER
 * (`status.headers`) and deduping against the header body set. Restores the
 * previous code buffer and destination state even if the build throws.
 * `mark_code_emitted` additionally records the code-body guard so a later
 * `.m` pass skips its own copy (used by the system-TU split and enum payload
 * hoisting, where the struct lives in the header only).
 */
export function build_struct_body_to_header(
	node: StructNode,
	status: BuildStatus,
	mark_code_emitted = true,
) {
	const swap = status.code;
	const saved_flag = status.struct_body_to_header;
	const saved_mark = status.struct_body_header_mark_code_emitted;
	status.code = status.headers;
	status.struct_body_to_header = true;
	status.struct_body_header_mark_code_emitted = mark_code_emitted;
	try {
		build_struct_body(node, status);
	} finally {
		status.headers = status.code;
		status.code = swap;
		status.struct_body_to_header = saved_flag;
		status.struct_body_header_mark_code_emitted = saved_mark;
	}
}

/**
 * A prototyped function that RETURNS a value struct by value forces that
 * struct's full typedef into the HEADER: the header holds the prototype
 * (`struct Box f(void);`), the `.m` includes the header, and a by-value
 * return/param needs the COMPLETE type wherever the declaration is visible.
 *
 * Emit those typedefs (and their embedded value-struct dependencies, in
 * dependency order) to the header BEFORE any code body is emitted, and record
 * them in the code-body guard so the later `.m` pass does not emit a second,
 * conflicting typedef. A whole-program pre-pass is required because the struct
 * may live nested inside a function body that is built after the by-value
 * method's own struct is built; emitting lazily at signature time races the
 * nested pass that has already written the code copy.
 *
 * Recurses into function bodies and struct methods (a nested struct's method
 * can be the by-value returner).
 */
export function emit_by_value_return_type_headers(root: BlockNode, status: BuildStatus) {
	const seen_fns = new Set<FunctionNode>();
	const visit_function = (fn: FunctionNode) => {
		if (seen_fns.has(fn)) return;
		seen_fns.add(fn);
		if (fn.is_generic || !fn.return_type) return;
		const mono = mono_type_name(fn.return_type);
		const return_struct = status.structs.find(
			(s) => s.name === mono && !s.is_simple_type && !s.is_generic,
		);
		if (return_struct && !return_struct.is_class) {
			emit_enum_deps_for_struct(return_struct, status);
			build_struct_body_to_header(return_struct, status, true);
		}
	};

	const visit_block = (block: BlockNode) => {
		for (const child of (block as unknown as { statements?: BaseNode[] }).statements ?? []) {
			const kind = (child as { node_type?: string }).node_type;
			if (kind === "func") {
				const fn = child as FunctionNode;
				visit_function(fn);
				if (fn.statements?.length) visit_block(fn as unknown as BlockNode);
			} else if (kind === "struct") {
				const struct = child as StructNode;
				for (const fn of struct.functions ?? []) visit_function(fn as FunctionNode);
				for (const fn of struct.functions ?? []) {
					const f = fn as FunctionNode;
					if (f.statements?.length) visit_block(f as unknown as BlockNode);
				}
			}
		}
	};
	visit_block(root);
}

function field_c_type(type: Type, status: BuildStatus): string {
	// A `view T` field is the universal non-mv (ptr, len) slice struct —
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
