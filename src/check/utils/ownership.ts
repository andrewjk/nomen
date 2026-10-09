import { direct_string_fields } from "../../build_common/has_string_fields.ts";
import { mono_type_name } from "../../build_common/mono_name.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import { child_nodes } from "../../nodes/child_nodes.ts";
import type EnumNode from "../../nodes/EnumNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import { is_box_type } from "./box.ts";

export function is_class_type(type_name: string, status: CheckStatus): boolean {
	return !!status.structs.find((s) => s.name === type_name && s.is_class);
}

/**
 * True if a value of `type_name` is stored in a container as an OWNED
 * 8-byte heap pointer that the container's `#destroy` will reclaim
 * per-element. That covers both classes (ClassBuffer<T> routing) and
 * traits (ClassBuffer<Trait> routing, dispatching destroy via the
 * vtable). Storing a BORROW of such a type into a `mv T` slot would
 * create shared ownership: the destination's destroy frees the pointer
 * while the source still references it (a runtime double-free, SIGABRT).
 */
export function is_owning_ref_type(type_name: string, status: CheckStatus): boolean {
	if (is_class_type(type_name, status)) return true;
	return !!status.traits.find((t) => t.name === type_name);
}

/**
 * Resolve a Type to its StructNode definition. Tries the exact (monomorphized)
 * name first, then a synthesized monomorphization name from type args
 * (e.g. List + [Animal] -> List_Animal).
 *
 * STRUCT_PLAN_3 D3: `string` keeps its built-in `is_simple_type` stamp — the
 * backends lower it as a primitive fat (ptr, len) pair, not a field-bearing
 * struct — but it IS a mv struct (`pub mv struct string`), so the
 * ownership predicates must see through that stamp.
 */
function resolve_struct(type: Type, status: CheckStatus): StructNode | undefined {
	if (!type.name) return undefined;
	const matches = (s: StructNode): boolean =>
		s.name === type.name && (!s.is_simple_type || type.name === "string");
	const direct = status.structs.find(matches);
	if (direct) return direct;
	if (type.type_args?.length) {
		const mono = mono_type_name(type);
		return status.structs.find((s) => s.name === mono && matches(s));
	}
	return undefined;
}

/**
 * Recursively determine whether an AST subtree contains a `raw` node (an inline
 * asm/C block) or a call to an `foreign` function. Used to tell apart a
 * `#destroy` that actually releases a resource from a benign cleanup hook that
 * only resets fields (e.g. `self.id = 0`). Releases are written either as raw
 * blocks (`free(...)` inside `#arch:` code — the pre-unsafe form) or as plain
 * Nomen calls to the memory externs (`free`/`realloc`/... declared
 * `foreign func`); both are un-analyzable resource releases. The walk skips
 * `scope`/`parent` back-edges and is cycle-guarded.
 */
function contains_release(node: BaseNode, visited: WeakSet<BaseNode>): boolean {
	if (!node || typeof node !== "object" || visited.has(node)) return false;
	visited.add(node);
	if (node.node_type === "raw") return true;
	const any_node = node as any;
	if (node.node_type === "func_call" || node.node_type === "access_func") {
		const resolved = any_node.resolved_function;
		if (resolved?.is_foreign) return true;
		// The generic body may be classified before its own statement was
		// reached (user structs are checked before the appended library), so
		// the call's stamp may be absent — resolve by name. Externs are
		// pre-registered at root gather time (check_block_node), making this
		// order-independent.
		const name = any_node.name as string | undefined;
		if (name && !resolved) {
			const func = externs_by_name.get(name);
			if (func?.is_foreign) return true;
		}
	}
	for (const child of child_nodes(node)) {
		if (contains_release(child, visited)) return true;
	}
	return false;
}

/** Root-level foreign declarations, populated by check_block_node's gather
 *  pass so ownership classification never depends on statement order. */
const externs_by_name = new Map<string, FunctionNode>();

export function register_foreign_for_ownership(func: FunctionNode): void {
	if (func.is_foreign) externs_by_name.set(func.name, func);
}

export function destroy_releases(func: FunctionNode): boolean {
	const visited = new WeakSet<BaseNode>();
	return func.statements.some((s) => contains_release(s, visited));
}

/**
 * True if `type` is a struct (not a class, not a primitive) that transitively
 * owns a resource that would be double-freed by a byte copy. That is:
 *   - its `#destroy` actually releases something (contains a raw block), or
 *   - it has a field that is a class, or another mv struct.
 *
 * A benign `#destroy` that only resets fields (no raw block) does NOT make a
 * struct mv — copying such a value type is safe. Classes are reference
 * types (assigning aliases the pointer, one owner), so they are not mv.
 */
export function is_owning_struct_type(type: Type, status: CheckStatus): boolean {
	// A `view T` / `ref` spelling is a BORROW, never an owner — even when the
	// underlying type is mv (`view string`, D3).
	if (type.is_view || type.is_ref) return false;
	const s = resolve_struct(type, status);
	if (!s || s.is_class) return false;
	// STRUCT_PLAN_3 B1: the DECLARED flag wins — `mv struct` is move-only
	// by declaration, regardless of what the field walk would infer. (The
	// inferred walk remains for undeclared structs during the transition.)
	if (s.is_owning) return true;
	return struct_owns_heap(s, status, new Set());
}

/**
 * Like `is_owning_struct_type`, but only counts NON-string ownership — i.e.
 * ownership that a scope-exit destroy would actually reclaim: a
 * resource-releasing `#destroy`, a class field, or a nested struct that owns
 * non-string resources. `string` fields are excluded: struct locals whose only
 * ownership is strings are NOT auto-destroyed at scope exit (the strings may
 * be rodata literals), so byte-copying such a struct out of a field is a sound
 * BORROW (the copy aliases the source's strings; neither side frees them).
 * A struct that owns a List/Buffer/class/… WOULD be destroyed, so copying it
 * by value would double-free — that's the case that must stay a `mv ... swap`.
 */
export function is_owning_struct_type_requiring_move(type: Type, status: CheckStatus): boolean {
	if (type.is_view || type.is_ref) return false;
	const s = resolve_struct(type, status);
	if (!s || s.is_class) return false;
	// B1: a declared `mv struct` is ALWAYS move-only — a string-only
	// field no longer makes it a borrow-copy (the declaration says the type
	// owns; the compiler no longer second-guesses it).
	if (s.is_owning) return true;
	return struct_owns_non_string_heap(s, status, new Set());
}

/**
 * Whether `type` is a concrete value struct with direct string fields whose
 * only ownership those strings — the pass-by-value convention's domain: a
 * parameter of this type is fully owned by the callee (the call boundary
 * materializes a uniformly heap-owned copy), so `var` field writes inside
 * the body stay local and no call-site acknowledgment is needed. Excludes
 * structs that own non-string heap (those keep `mv ... swap` / `ref`
 * semantics), structs conforming to traits (trait dispatch aliases), and —
 * B1 full cutover — DECLARED `mv struct`s: the declaration is the
 * move-only contract, so a bare parameter is a read-only const borrow (B3),
 * never an implicit copy.
 */
export function is_pass_by_value_owning_struct(type: Type, status: CheckStatus): boolean {
	const s = resolve_struct(type, status);
	if (!s || s.is_class || s.is_generic || s.is_simple_type) return false;
	if (s.is_owning) return false;
	if ((s.traits ?? []).length > 0) return false;
	if (direct_string_fields(s).length === 0) return false;
	if (struct_owns_non_string_heap(s, status, new Set())) return false;
	return true;
}

export function struct_owns_non_string_heap(
	s: StructNode,
	status: CheckStatus,
	visited: Set<string>,
): boolean {
	if (visited.has(s.name)) return false;
	visited.add(s.name);
	const destroy = s.functions.find((f) => f.name === "#destroy");
	if (destroy && destroy_releases(destroy)) return true;
	for (const field of s.fields) {
		if (field.type.is_ref) continue;
		// A `view T` field is a non-mv (ptr, len) pair — byte-copying it
		// aliases nothing owned, so it never makes a struct mv.
		if (field.type.is_view) continue;
		// A string field is owned by a container slot / constructor strdup,
		// but a struct LOCAL is not auto-destroyed for it — copying is a borrow.
		if (field.type.name === "string") continue;
		const field_struct = resolve_struct(field.type, status);
		if (!field_struct) continue;
		if (field_struct.is_class) return true;
		if (struct_owns_non_string_heap(field_struct, status, visited)) return true;
	}
	return false;
}

function struct_owns_heap(s: StructNode, status: CheckStatus, visited: Set<string>): boolean {
	if (visited.has(s.name)) return false;
	visited.add(s.name);
	const destroy = s.functions.find((f) => f.name === "#destroy");
	if (destroy && destroy_releases(destroy)) return true;
	for (const field of s.fields) {
		if (field.type.is_ref) continue;
		// A `view T` field owns nothing (a borrowed pair) — copying it is sound.
		if (field.type.is_view) continue;
		// A `string` field owns heap memory (a strdup'd char*). The field
		// may hold a static literal pointer at runtime, but the mv copy
		// (constructor strdup, deep-copy on container store) is always heap.
		if (field.type.name === "string") return true;
		const field_struct = resolve_struct(field.type, status);
		if (!field_struct) continue;
		if (field_struct.is_class) return true;
		if (struct_owns_heap(field_struct, status, visited)) return true;
	}
	return false;
}

/**
 * STRUCT_PLAN_3 B1 full cutover — the OWNING side of the Copyable predicate,
 * as it applies to a struct field's (or enum case payload's) type. Owning:
 * `string` (D3 — the fat pair owns its bytes; covers `string[N]` arrays
 * too, whose elements are mv), class types (the compiler-stamped `Box<T>`
 * wrapper is one), declared-`mv` structs, structs the inferred walk flags
 * (string fields, a resource-releasing `#destroy`, transitively), declared-
 * `mv` enums, and enums whose payloads are mv (the inferred half of
 * B1a). NOT mv: `view T` (a (ptr, len) borrow is Copyable, region-bound),
 * `ref` (rejected at fields/payloads elsewhere), scalars, `func` types,
 * bitsets.
 *
 * This is the predicate the Copyable verifier
 * (check_struct_node / check_enum_node) runs over every field of a bare
 * `struct` / `enum`: one `true` means the declaration cannot be Copyable and
 * must be spelled `mv`.
 */
export function type_owns_heap(t: Type, status: CheckStatus): boolean {
	if (!t.name || t.is_ref || t.is_view) return false;
	if (t.name === "string") return true;
	if (is_class_type(t.name, status) || is_box_type(t.name, status.structs)) return true;
	const en = status.enums.find((e) => e.name === t.name);
	if (en) {
		if (en.is_owning) return true;
		return enum_owns_payloads(en, status, new Set());
	}
	return is_owning_struct_type(t, status);
}

/** Whether any case payload of `en` owns heap (see `type_owns_heap`). */
function enum_owns_payloads(en: EnumNode, status: CheckStatus, visited: Set<string>): boolean {
	if (visited.has(en.name)) return false;
	visited.add(en.name);
	for (const c of en.cases) {
		for (const p of c.params) {
			if (type_owns_heap(p.type, status)) return true;
		}
	}
	return false;
}
