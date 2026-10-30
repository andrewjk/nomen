import { get_built_in_type } from "../built_in_types.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type Type from "../nodes/Type.ts";

/**
 * Struct field-order packing (PERF_PLAN item 12).
 *
 * Struct fields historically laid out in DECLARATION order, so a struct like
 * `{ int64 a; bool f; int64 b; bool g; }` carries 7 bytes of alignment
 * padding per instance (40 bytes instead of 32) — and every `List<T>`/`Map`
 * slot, memcpy, and constructor copy pays the inflated stride. Packing sorts
 * each struct's own fields by ALIGNMENT DESCENDING (stable within equal
 * alignment, so all-word structs keep their declaration order byte-for-byte),
 * which collects the sub-8-byte scalars (bool/char/int8/16/32) at the tail
 * where they fit into what was padding.
 *
 * Every type's size is a multiple of its natural alignment in this type
 * system (scalars: size == alignment; structs/views/strings: multiples of 8),
 * so a descending-alignment order is GAP-FREE — the aligned layout walk never
 * inserts padding — which keeps the raw unaligned cursor walks in the aarch64
 * owning-buffer/destroy specializations exact, and matches C's naturally
 * aligned layout of the identically ordered typedef member-for-member.
 *
 * `struct.fields` itself stays in declaration order: the auto-generated
 * `#init` binds its parameters positionally in field order (`Pt(1, 2)`), so
 * permuting the array would silently flip every positional construction.
 * Packing is a LAYOUT-ORDER VIEW consumed by the three layout authorities —
 * the aarch64 offset walk (`layout_fields`), the C typedef emission
 * (build_struct_body / c_companion), and the check-side `raw_type_size`
 * T_SIZE mirror — which must all agree.
 */

/**
 * Natural alignment of a field type in bytes — the status-free mirror of
 * `get_type_alignment` (build_aarch64/utils/struct_layout.ts): every
 * status-dependent branch there (struct, class, enum, array lookups) aligns
 * to 8, so only the built-in scalar widths matter. Sub-8-byte scalars
 * (bool, char, int8/16/32) align to their storage width; everything else
 * aligns to 8 — matching C struct rules, because raw `#arch: c` bodies and
 * companion code read the SAME fields through C's naturally-aligned layout.
 */
export function packing_alignment(type: Type): number {
	if (type.is_view) return 8;
	if (type.is_ref || type.is_array) return 8;
	const bytes = get_built_in_type(type.name)?.bytes;
	if (bytes === 1 || bytes === 2 || bytes === 4) return bytes;
	return 8;
}

/** A struct-shaped node: everything the skip predicate and the sort need. */
export interface PackableStruct {
	name?: string;
	fields: DeclarationNode[];
	functions?: FunctionNode[];
}

/**
 * Whether a struct's layout may be packed. Excluded (declaration order,
 * exactly as before):
 *
 * - Tuple structs (`_Tuple_*`): positional index access is their contract.
 * - Structs with raw `#arch` bodies: the raw text hardcodes field offsets
 *   (StableList pins `length @8`, `items.data @24`, …), so reordering the
 *   fields they read corrupts them. Conservative: ANY raw body in ANY of the
 *   struct's functions skips the whole struct — the same "raw bodies are
 *   opaque" treatment scan_inline_candidates/scan_moved_param_consumed use.
 *   Monomorphized clones carry their raw statements through substitution, so
 *   a generic and its monos always decide the same way.
 * - Structs with fixed-size stack-array fields: the C backend emits
 *   `T name[N]` (no header) while the aarch64 layout sizes a stack array as
 *   `8 + elem*len` (length header) — the two layouts already disagree on such
 *   fields, and packing would scatter that disagreement across the struct.
 *   Keeping them declaration-order changes nothing.
 */
export function struct_packs_fields(struct: PackableStruct): boolean {
	if (struct.name?.startsWith("_Tuple_")) return false;
	if (
		struct.functions?.some((fn) =>
			fn.statements?.some((s) => (s as { node_type?: string }).node_type === "raw"),
		)
	)
		return false;
	if (struct.fields.some((f) => f.type.is_array && !f.type.is_array_heap)) return false;
	return true;
}

/**
 * The struct's own fields in PACKED layout order (empty for structs the skip
 * predicate excludes — those return the declaration-order array itself).
 * Memoized on the struct object: `layout_fields` runs per field access during
 * the build, and the sort must not show up in compiler time.
 */
const pack_order_cache = new WeakMap<object, DeclarationNode[]>();
const pack_decision_cache = new WeakMap<object, boolean>();

export function packed_own_fields<T extends PackableStruct>(struct: T): DeclarationNode[] {
	if (!pack_decision(struct)) return struct.fields;
	const cached = pack_order_cache.get(struct);
	if (cached) return cached;
	const packed = [...struct.fields].sort(
		(a, b) => packing_alignment(b.type) - packing_alignment(a.type),
	);
	pack_order_cache.set(struct, packed);
	return packed;
}

function pack_decision(struct: PackableStruct): boolean {
	let decision = pack_decision_cache.get(struct);
	if (decision === undefined) {
		decision = struct_packs_fields(struct);
		pack_decision_cache.set(struct, decision);
	}
	return decision;
}

/**
 * Trait-declared fields the struct does not override, in PACKED order —
 * the companion of `packed_own_fields` for the trait-merge tail that
 * `layout_fields` (aarch64) and the C typedef emitters append after the own
 * fields. Sorted among themselves for the same gap-free property; they stay
 * AFTER the own fields so every consumer that walks only `struct.fields`
 * (the ctor parameter order, per-name offset lookups over own fields)
 * keeps its existing contract.
 */
export function packed_trait_extra_fields(
	struct: {
		fields: DeclarationNode[];
		traits?: string[];
		name?: string;
		functions?: FunctionNode[];
	},
	traits: { name: string; fields: DeclarationNode[] }[] | undefined,
): DeclarationNode[] {
	if (!struct.traits?.length || !traits) return [];
	const extra: DeclarationNode[] = [];
	for (const trait_name of struct.traits) {
		const trait = traits.find((t) => t.name === trait_name);
		if (!trait) continue;
		for (const f of trait.fields) {
			if (!struct.fields.find((nf) => nf.name === f.name)) extra.push(f);
		}
	}
	if (!extra.length) return extra;
	return pack_decision(struct)
		? extra.sort((a, b) => packing_alignment(b.type) - packing_alignment(a.type))
		: extra;
}
