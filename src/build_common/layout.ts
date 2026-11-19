import { get_built_in_type } from "../built_in_types.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type Type from "../nodes/Type.ts";
import { is_nullable_scalar_type } from "./nullable_scalar.ts";
import { is_nullable_struct_type } from "./nullable_struct.ts";
import { packed_own_fields, packed_trait_extra_fields } from "./struct_packing.ts";

/**
 * The compiler's shared struct-layout model — sizes, alignments and field
 * offsets — extracted from `build_aarch64/utils/struct_layout.ts` so the
 * check-time comptime reflection (`META.size_of` / `META.align_of` /
 * `META.offset_of`) answers from the SAME walk the aarch64 backend emits
 * with, not a third re-implementation (the check-side raw-body `T_SIZE`
 * mirror is one already).
 *
 * The model: every struct value starts with an 8-byte vtable pointer
 * (LAYOUT_VT_SIZE); fields follow in PACKED order (build_common/
 * struct_packing.ts — alignment-descending, plus trait-declared fields at
 * the tail), each aligned to its natural alignment, with a nullable field's
 * companion `_has` flag right after its storage; the total is tail-padded to
 * 8 so arrays of the struct keep every element aligned. This reproduces C's
 * naturally-aligned layout of the identically ordered typedef member-for-
 * member, which is what keeps raw `#arch: c` bodies, the C `sizeof`s and the
 * aarch64 offsets in agreement.
 *
 * The one place the backends disagree: a FIXED-SIZE stack-array field
 * (`uint64[4] slots`). The aarch64 layout stores a length-header word before
 * the elements (`8 + elem * len`); the C typedef makes the field an inline C
 * array (`uint64 slots[4];` — `elem * len`, element alignment). Pass target
 * `"c"` for the C ABI; the default is the native aarch64 model.
 */

/** Byte size of the vtable pointer every struct value starts with. */
export const LAYOUT_VT_SIZE = 8;

/** Which backend's ABI a layout walk answers for. */
export type LayoutTarget = "aarch64" | "c";

/** The struct/trait/enum tables a layout walk consults. CheckStatus and
 *  BuildStatus both satisfy this structurally — pass the status itself. */
export interface LayoutTables {
	structs: LayoutStruct[];
	enums: LayoutEnum[];
	traits?: LayoutTrait[];
	bitsets: { name: string; source_name?: string }[];
}

export interface LayoutStruct {
	name?: string;
	is_simple_type?: boolean;
	is_class?: boolean;
	is_generic?: boolean;
	fields: DeclarationNode[];
	traits?: string[];
	functions?: FunctionNode[];
}

export interface LayoutEnum {
	name: string;
	is_generic?: boolean;
	has_associated_data?: boolean;
	cases: { name?: string; params: { type: Type }[] }[];
}

export interface LayoutTrait {
	name: string;
	fields: DeclarationNode[];
}

/** Natural alignment of a BUILT-IN type name — the status-free rule:
 *  sub-8-byte scalars (bool, char, int8/16/32) align to their storage
 *  width; everything else to 8. */
function built_in_alignment(name: string): number {
	const bytes = get_built_in_type(name)?.bytes;
	if (bytes === 1 || bytes === 2 || bytes === 4) return bytes;
	return 8;
}

/** Storage width of a BUILT-IN type name in bytes — the build_common mirror
 *  of `build_aarch64/utils/aarch64_size.ts` (which this module must not
 *  import): `string` is the fat 16-byte (ptr, len) pair, other built-ins
 *  use BuiltInTypeInfo.bytes, unknown names are one word. */
function built_in_size(name: string): number {
	if (name === "string") return 16;
	return get_built_in_type(name)?.bytes ?? 8;
}

/** Round `offset` up to `alignment` (alignment is a power of two). */
export function layout_align_to(offset: number, alignment: number): number {
	return Math.ceil(offset / alignment) * alignment;
}

/**
 * Natural alignment of a type in bytes — must match C struct layout rules,
 * because raw `#arch: c` bodies and companion code read the SAME fields
 * through C's naturally-aligned layout. Sub-8-byte scalars (bool, char,
 * int8/16/32) align to their own storage width (BuiltInTypeInfo.bytes);
 * everything else (word-sized ints, floats, fat strings, pointers, nested
 * structs) aligns to 8.
 */
export function layout_type_alignment(
	type: Type,
	tables: LayoutTables,
	target: LayoutTarget = "aarch64",
): number {
	// A `view T` field is a (ptr, len) pair of words — 8-byte aligned like
	// every other pointer-bearing value (checked before the struct lookup so
	// a view OF a struct doesn't recurse into element layout rules).
	if (type.is_view) return 8;
	const struct = tables.structs.find((s) => s.name === type.name && !s.is_simple_type);
	if (type.is_ref || (struct && struct.is_class)) return 8;
	if (struct) return 8;
	const enum_node = tables.enums.find((e) => e.name === type.name);
	if (enum_node) return 8;
	if (type.is_array) {
		// The C target's fixed stack-array field is an inline C array — it
		// aligns like its element (the aarch64 length-header shape is
		// word-aligned like every other pointer-bearing value).
		if (target === "c" && !type.is_array_heap && !type.elem && type.length) {
			return built_in_alignment(type.name);
		}
		return 8;
	}
	return built_in_alignment(type.name);
}

/**
 * A struct's fields in layout order, INCLUDING trait-declared fields that
 * the struct does not override. The C backend emits trait fields into the
 * typedef (the C compiler lays them out); the aarch64 layout must account
 * for them too, or a trait field's offset lands past the allocated
 * instance.
 *
 * Own fields are PACKED (alignment-descending — see
 * build_common/struct_packing.ts) unless the struct is excluded (raw `#arch`
 * bodies, tuples, fixed-array fields); trait extras follow, packed among
 * themselves. Field declaration order is untouched on the node itself — the
 * positional `#init` contract depends on it.
 */
export function packed_layout_fields(
	struct: {
		name?: string;
		fields: DeclarationNode[];
		traits?: string[];
		functions?: FunctionNode[];
	},
	tables: LayoutTables,
): DeclarationNode[] {
	const own = packed_own_fields(struct);
	if (!struct.traits?.length) return own;
	const extra = packed_trait_extra_fields(struct, tables.traits);
	return extra.length ? [...own, ...extra] : own;
}

export function layout_struct_size(
	name: string,
	tables: LayoutTables,
	target: LayoutTarget = "aarch64",
): number {
	const struct = tables.structs.find((s) => s.name === name);
	if (!struct) return LAYOUT_VT_SIZE;
	if (struct.is_simple_type) return LAYOUT_VT_SIZE;
	let size = LAYOUT_VT_SIZE;
	for (const field of packed_layout_fields(struct, tables)) {
		size = layout_align_to(size, layout_type_alignment(field.type, tables, target));
		size += layout_type_size(field.type, tables, target);
		// A nullable struct field carries a companion 8-byte `_has` flag; a
		// nullable scalar field a 1-byte `_has` flag right after the scalar
		// (both match C's `unsigned char <f>_has;` member layout).
		if (is_nullable_struct_type(field.type, tables)) size += 8;
		else if (is_nullable_scalar_type(field.type, tables)) size += 1;
	}
	// Tail padding to the strictest member alignment so arrays of the struct
	// keep every element aligned (matches C's sizeof).
	size = layout_align_to(size, 8);
	return size;
}

export function layout_type_size(
	type: Type,
	tables: LayoutTables,
	target: LayoutTarget = "aarch64",
): number {
	if (type.is_ref) return 8;
	// A `view T` is the universal (ptr, len) pair — 16 bytes regardless of
	// the element type (a view of a struct is a slice, NOT the struct value).
	if (type.is_view) return 16;
	const struct = tables.structs.find((s) => s.name === type.name && !s.is_simple_type);
	if (struct) {
		if (struct.is_class) return 8;
		return layout_struct_size(type.name, tables, target);
	}
	// Enums: an enum with associated data is multi-word (tag + payload), so
	// its size must come from layout_enum_size, not the default 8 — otherwise
	// struct field offsets and struct sizes under-count a 16-byte enum and
	// the next field overlaps its payload.
	const enum_node = tables.enums.find((e) => e.name === type.name);
	if (enum_node) {
		return layout_enum_size(type.name, tables);
	}
	const element_size = built_in_size(type.name);
	// A NESTED-array field is a heap outer-buffer POINTER (its slots are row
	// pointers) — never inline row storage, whatever compile-time length the
	// annotation spells. A fixed-size stack-array field carries a length
	// header word on aarch64; the C target's typedef field is an inline C
	// array (`T name[N];`) with no header.
	if (type.is_array && !type.elem && type.length && (type.length.start ?? -1) >= 0) {
		const length = parseInt((type.length as unknown as { value: string }).value || "0");
		return (target === "c" ? 0 : 8) + element_size * length;
	}
	if (type.is_array) return 8;
	return element_size;
}

export function layout_field_offset(
	struct_name: string,
	field_name: string,
	tables: LayoutTables,
	target: LayoutTarget = "aarch64",
): number {
	const struct = tables.structs.find((s) => s.name === struct_name);
	if (!struct) return LAYOUT_VT_SIZE;
	return layout_field_offset_of_fields(
		packed_layout_fields(struct, tables),
		field_name,
		tables,
		target,
	);
}

/**
 * Aligned field-offset walk shared by every consumer of struct layout
 * (field access, destroy emission, ctor copies): each field starts at the
 * next position aligned to its natural alignment, with an extra 8-byte
 * `_has` flag word after a nullable struct field.
 */
export function layout_field_offset_of_fields(
	fields: DeclarationNode[],
	field_name: string,
	tables: LayoutTables,
	target: LayoutTarget = "aarch64",
): number {
	let offset = LAYOUT_VT_SIZE;
	for (const field of fields) {
		offset = layout_align_to(offset, layout_type_alignment(field.type, tables, target));
		if (field.name === field_name) return offset;
		offset += layout_type_size(field.type, tables, target);
		// Skip the companion `_has` flag following a nullable struct field
		// (8-byte word) or nullable scalar field (1 byte).
		if (is_nullable_struct_type(field.type, tables)) offset += 8;
		else if (is_nullable_scalar_type(field.type, tables)) offset += 1;
	}
	return offset;
}

export function layout_enum_size(enum_name: string, tables: LayoutTables): number {
	const enum_node = tables.enums.find((e) => e.name === enum_name);
	if (!enum_node || !enum_node.has_associated_data) return 8;
	let max_payload = 0;
	for (const c of enum_node.cases) {
		let case_size = 0;
		for (const p of c.params) {
			// Use layout_type_size, not a word: a struct payload (e.g. a
			// string-bearing value struct) is multi-word, and sizing it as one
			// word truncated the enum blob and mis-offset every later payload.
			case_size += layout_type_size(p.type, tables);
		}
		max_payload = Math.max(max_payload, case_size);
	}
	return 8 + Math.ceil(max_payload / 8) * 8;
}

/**
 * META.size_of support — byte size of a type by NAME against the layout
 * tables. Generic spellings have no concrete layout (undefined); a class
 * value is a heap pointer (8); a bitset is a word of flags (8); built-in
 * scalars and `string` use their storage width. Unknown names return
 * undefined so the caller can defer to the downstream unknown-name error.
 */
export function layout_size_of_name(
	name: string,
	tables: LayoutTables,
	target: LayoutTarget = "aarch64",
): number | undefined {
	const struct = tables.structs.find((s) => s.name === name && !s.is_simple_type);
	if (struct) {
		if (struct.is_generic) return undefined;
		if (struct.is_class) return 8;
		return layout_struct_size(name, tables, target);
	}
	const enum_node = tables.enums.find((e) => e.name === name && !e.is_generic);
	if (enum_node) return layout_enum_size(name, tables);
	if (tables.bitsets.some((b) => b.name === name || b.source_name === name)) return 8;
	if (get_built_in_type(name)) return built_in_size(name);
	return undefined;
}

/**
 * META.align_of support — natural alignment of a type by NAME. Structs,
 * enums, classes and bitsets are word-aligned (the vtable word leads every
 * struct, and every composite value rides whole words); built-in scalars
 * align to their storage width (`string` to 8 — it is a (ptr, len) pair).
 */
export function layout_align_of_name(name: string, tables: LayoutTables): number | undefined {
	const struct = tables.structs.find((s) => s.name === name && !s.is_simple_type);
	if (struct) {
		if (struct.is_generic) return undefined;
		return 8;
	}
	if (tables.enums.find((e) => e.name === name && !e.is_generic)) return 8;
	if (tables.bitsets.some((b) => b.name === name || b.source_name === name)) return 8;
	if (get_built_in_type(name)) return built_in_alignment(name);
	return undefined;
}

/**
 * META.offset_of support — byte offset of a field within its struct value,
 * measured from the value's first byte (the vtable word included). A
 * non-struct value (built-in, class, enum, bitset) has no inline fields —
 * undefined, which the caller reports as "has no field".
 */
export function layout_field_offset_of_name(
	struct_name: string,
	field_name: string,
	tables: LayoutTables,
	target: LayoutTarget = "aarch64",
): number | undefined {
	const struct = tables.structs.find((s) => s.name === struct_name && !s.is_simple_type);
	if (!struct || struct.is_generic || struct.is_class) return undefined;
	if (!packed_layout_fields(struct, tables).some((f) => f.name === field_name)) return undefined;
	return layout_field_offset(struct_name, field_name, tables, target);
}
