import { element_load_aliases_destroy_state } from "../../build_common/destroy_analysis.ts";
import { is_container_borrow_accessor_name } from "../../build_common/string_return_analysis.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import { is_owning_ref_type } from "./ownership.ts";
import type_from_value_node from "./type_from_value_node.ts";
import value_from_value_node from "./value_from_value_node.ts";

/**
 * The scope depth a value's lifetime is rooted at, when the value is a borrow
 * whose validity depends on some owner. Returns undefined for owned values.
 *
 * Borrows arise from:
 *  - class field access (`p.a`) — borrow of `p`, taken in the current scope;
 *  - an instance method call returning a class (`list.pop()`, `arr.first()`)
 *    — borrow of the receiver, rooted at the receiver's lifetime;
 *  - an instance method call returning a `view T` (e.g. `s.slice(0, 3)`)
 *    — a non-mv slice that borrows from the receiver;
 *  - a variable that already holds one of the above.
 *
 * Constructors and static factories (`Box(1)`, `Array.with(...)`) produce owned
 * values (not borrows). A borrow may not be assigned/returned to a variable
 * declared at a shallower (outer) scope than its root depth.
 */
export function borrow_depth_of(node: BaseNode, status: CheckStatus): number | undefined {
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const t = type_from_value_node(access, status);
			if (t?.name && is_owning_ref_type(t.name, status)) {
				return status.scope_depth;
			}
			// Reading a `view T` FIELD yields a non-mv slice whose validity
			// is rooted at the struct instance it was read from (the instance's
			// own borrow depth covers its fields' sources).
			if (t?.is_view && access.target.node_type === "value") {
				const base = status.values.findLast((v) => v.name === (access.target as ValueNode).value);
				return Math.max(base?.borrow_depth ?? 0, status.scope_depth);
			}
		} else if (access.access.node_type === "access_func") {
			const t = type_from_value_node(access, status);
			const borrows_from_receiver =
				// A `mv out T` method transfers ownership — the result is an
				// owned value, not a borrow.
				(is_borrowed_return(t, status) &&
					!(access.access as AccessFunctionCallNode).owned_return) ||
				is_element_load_pure_borrow(access, status);
			if (borrows_from_receiver) {
				// Instance method returning a class/view (or an element-load
				// pure borrow) borrows from its receiver. Static calls (receiver
				// is a type name, not a variable in scope) and constructors
				// produce owned values.
				if (access.target.node_type === "value") {
					const recv = status.values.findLast((v) => v.name === (access.target as ValueNode).value);
					if (recv) {
						return recv.borrow_depth ?? recv.decl_depth ?? status.scope_depth;
					}
					return undefined;
				}
				return status.scope_depth;
			}
		}
	}
	if (node.node_type === "value") {
		const decl = status.values.findLast((v) => v.name === (node as ValueNode).value);
		return decl?.borrow_depth;
	}
	return undefined;
}

/**
 * The ultimate owner variable a child-group borrow is rooted in, or undefined
 * for owned values. Mirrors `borrow_depth_of`'s classification:
 *  - class field access (`p.a`) → owner is `p` (or p's own owner, transitively);
 *  - instance method returning a class (`list.pop()`) → owner is the receiver
 *    (or its owner, transitively);
 *  - a variable holding a borrow → that variable's owner.
 *
 * Constructors / static calls produce owned values (undefined). This is the
 * reverse index that `borrow_depth` lacks: it records *which* owner a borrow
 * depends on, so the borrow can be invalidated when that owner is mutated.
 */
export function borrow_owner_of(node: BaseNode, status: CheckStatus): string | undefined {
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const t = type_from_value_node(access, status);
			if (t?.name && is_owning_ref_type(t.name, status)) {
				return ultimate_owner(access.target, status);
			}
			// A `view T` field read roots at the struct variable it was read
			// from (mirroring borrow_depth_of's field case).
			if (t?.is_view) {
				return ultimate_owner(access.target, status);
			}
		} else if (access.access.node_type === "access_func") {
			const t = type_from_value_node(access, status);
			const call = access.access as AccessFunctionCallNode;
			const borrows_from_receiver =
				// A `mv out T` method returns an owned value — no owner to root
				// a borrow at (and it must not be invalidated by receiver
				// mutation). The element-load pure borrow joins the class case.
				(is_borrowed_return(t, status) && !call.owned_return) ||
				is_element_load_pure_borrow(access, status) ||
				// The checker-rewritten ELEMENT BORROW (`ref x = c.at(i)` /
				// `ref v = m.get_or_panic(k)` → slot_ptr/get_ptr) names the
				// container's slot for EVERY element type — scalars included —
				// so a `ref self` call on the container must invalidate it.
				call.is_element_slot_load === true;
			if (borrows_from_receiver) {
				if (access.target.node_type === "value") {
					const recv = status.values.findLast((v) => v.name === (access.target as ValueNode).value);
					if (recv) {
						// A static call (receiver is a type name, not a variable)
						// returns undefined above; only a tracked receiver borrows.
						return recv.borrowed_from ?? recv.name;
					}
					return undefined;
				}
				// Access-path receiver (e.g. z.animals.pop()): an instance method
				// on a field path — root the borrow at the ultimate mv var.
				return ultimate_owner(access.target, status);
			}
		}
	}
	if (node.node_type === "value") {
		const decl = status.values.findLast((v) => v.name === (node as ValueNode).value);
		return decl?.borrowed_from;
	}
	return undefined;
}

/**
 * Whether a method-call result type is a borrow of its receiver (rather than an
 * owned value). True for class-/trait-typed returns and for `view T` returns;
 * false for primitives, constructors, and `mv out T` (owned) returns. Traits
 * are reference types just like classes (a trait-typed value is a heap pointer
 * into someone else's ClassBuffer<Trait> slot), so an instance method returning
 * a trait borrows from its receiver the same way a class-typed return does.
 */
function is_borrowed_return(t: Type | undefined, status: CheckStatus): boolean {
	if (!t) return false;
	if (t.is_view) return true;
	return !!t.name && is_owning_ref_type(t.name, status);
}

/**
 * The `List<Own>.at()` pure borrow (FOLLOWUP.md): a container borrow accessor
 * (`list.at(i)` — the accessor family, non-`mv out`) whose value-struct
 * element aliases destroy-worthy state the load cannot privatize. The result
 * is a borrow of the slot's resources — rooted at the container exactly like
 * a class-typed method return, so a `ref self` call on the container
 * invalidates it, it cannot escape its scope, and it cannot transfer through
 * `mv`. Deliberately name-scoped to the accessor family: any method may
 * return a `#destroy`-bearing struct by value as an OWNED transfer.
 */
function is_element_load_pure_borrow(access: AccessNode, status: CheckStatus): boolean {
	const func_access = access.access as AccessFunctionCallNode;
	if (func_access.owned_return) return false;
	if (!is_container_borrow_accessor_name(func_access.name ?? "")) return false;
	const t = type_from_value_node(access, status);
	if (!t?.name || t.is_view || t.is_array) return false;
	const elem = status.structs.find((s) => s.name === t.name && !s.is_simple_type && !s.is_generic);
	if (!elem || elem.is_class) return false;
	return element_load_aliases_destroy_state(elem, status);
}

/**
 * The field path (excluding the owner root) a borrow-expression was taken
 * through — the via-half of the (`borrowed_from`, `borrowed_via`) borrow key
 * (FIELD_EFFECTS.md). Mirrors `borrow_owner_of`'s classification:
 *  - field access (`h.data`) → "data"; deeper paths keep the full tail
 *    (`a.b.c` → "b.c");
 *  - a borrow-returning method call roots at its receiver's path
 *    (`z.animals.at(i)` → "animals"); a bare-variable receiver has no field
 *    in its path → undefined (the borrow points at the owner as a whole);
 *  - a variable holding a borrow → that variable's own path.
 *
 * Declared-effect invalidation (`invalidate_borrows_of`'s `fields`) matches
 * a declared field F against this path by exact match or path prefix
 * (`data` covers `data.items`).
 */
export function borrowed_via_of(node: BaseNode, status: CheckStatus): string | undefined {
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const tail = borrowed_via_of(access.target, status);
			const field = (access.access as { name?: string }).name ?? "";
			return field ? (tail ? `${tail}.${field}` : field) : tail;
		}
		if (access.access.node_type === "access_func") {
			// A borrow-returning method roots at its receiver's path; a bare
			// variable receiver contributes no field, so the borrow stays
			// unstamped (conservatively invalidated by every mutator).
			return borrowed_via_of(access.target, status);
		}
		return undefined;
	}
	if (node.node_type === "value") {
		const decl = status.values.findLast((v) => v.name === (node as ValueNode).value);
		return decl?.borrowed_via;
	}
	return undefined;
}

/**
 * Whether a declared field set poisons a borrow taken via `path`. The set
 * holds top-level field names; a declared field kills the borrow when the
 * borrow's path IS that field or lives under it (`data` covers `data.x` —
 * displacing `data` displaces everything through it). Unstamped borrows are
 * poisoned regardless (conservative default).
 */
export function declared_fields_cover_path(
	fields: string[] | undefined,
	path: string | undefined,
): boolean {
	if (!path) return true;
	if (!fields?.length) return false;
	return fields.some((f) => path === f || path.startsWith(`${f}.`));
}

/**
 * Resolve an access target down to its ultimate mv variable name. Recurses
 * through field paths so `z.animals` → `z` (and `a.b.c` → `a`).
 */
function ultimate_owner(target: BaseNode, status: CheckStatus): string | undefined {
	if (target.node_type === "value") {
		const name = (target as ValueNode).value;
		const decl = status.values.findLast((v) => v.name === name);
		return decl?.borrowed_from ?? name;
	}
	if (target.node_type === "access") {
		return ultimate_owner((target as AccessNode).target, status);
	}
	return value_from_value_node(target) ?? undefined;
}

/**
 * The owner whose child-group borrows a method-call receiver mutation
 * invalidates. A bare variable receiver (`list`, or a borrow `x`) resolves to
 * itself — mutating it threatens its own subtree, not its owner's siblings. A
 * field-path receiver (`z.animals`) has no name of its own, so it roots at the
 * base variable (`z`). Returns undefined for `self` and for static calls.
 */
export function receiver_owner_of(target: BaseNode, status: CheckStatus): string | undefined {
	if (target.node_type === "value") {
		const name = (target as ValueNode).value;
		if (name === "self") return undefined;
		// Static call (type name, not a tracked variable) → nothing to invalidate.
		if (!status.values.findLast((v) => v.name === name)) return undefined;
		return name;
	}
	if (target.node_type === "access") {
		const owner = ultimate_owner(target, status);
		if (!owner || owner === "self") return undefined;
		return owner;
	}
	return undefined;
}

/**
 * Whether a declaration/assignment initializer is an ELEMENT BORROW shape: a
 * value that aliases the CONTAINER's storage rather than a deferred-reclaimed
 * class instance. Two spellings:
 *  - the checker-rewritten slot load (`ref x = c.at(i)` → `slot_ptr` /
 *    `ref v = m.get_or_panic(k)` → `get_ptr`), stamped `is_element_slot_load`;
 *  - a pure element-borrow accessor read (`is_element_load_pure_borrow` —
 *    the `List<Own>.at()` family whose load cannot privatize the element's
 *    destroy-worthy state).
 * Stamped as StackValue.is_element_borrow so the owner's REASSIGNMENT — which
 * frees the old slab eagerly (the displaced destroy) — can poison exactly
 * these, while class child-group borrows stay valid under deferred
 * reclamation.
 */
export function is_element_borrow_value(value: BaseNode | undefined, status: CheckStatus): boolean {
	if (!value || value.node_type !== "access") return false;
	const access = value as AccessNode;
	if (access.access.node_type !== "access_func") return false;
	if ((access.access as AccessFunctionCallNode).is_element_slot_load === true) return true;
	return is_element_load_pure_borrow(access, status);
}

/**
 * Mark every live ELEMENT borrow rooted at `owner` as invalidated. An element
 * borrow points INTO the owner's slab; unlike a class child-group borrow —
 * which owner reassignment keeps valid through deferred reclamation
 * (`has_live_borrow`) — the displaced mv container is destroyed eagerly at the
 * reassignment, so the borrow's storage is gone immediately. The narrower
 * companion of `invalidate_borrows_of` for the reassignment path (the `ref
 * self` receiver path keeps poisoning everything).
 */
export function invalidate_element_borrows_of(status: CheckStatus, owner: string) {
	for (const v of status.values) {
		if (v.borrowed_from === owner && v.is_element_borrow) {
			v.borrow_invalidated = true;
		}
	}
}

/**
 * Mark every live VIEW borrow rooted at `owner` as invalidated. Used when a
 * bare variable is reassigned: a `view string`/`view T[]` slice points into
 * the old buffer, which is freed at the reassignment, so the view dangles.
 * Struct variables whose `view T` fields borrow from `owner` (see
 * StackValue.view_field_owners) are recorded in invalidated_view_structs so
 * reading one of those fields afterwards is rejected — without poisoning the
 * whole struct value (its non-view fields stay usable).
 *
 * This is intentionally NARROWER than `invalidate_borrows_of`: class
 * child-group borrows are kept valid across owner reassignment by deferred
 * reclamation (the old instance is freed at scope exit, after the borrow's
 * own scope ends), so they must NOT be invalidated here. Only views — whose
 * backing buffer is reclaimed immediately on reassignment — need this.
 */
export function invalidate_view_borrows_of(status: CheckStatus, owner: string, fields?: string[]) {
	for (const v of status.values) {
		if (!v.borrowed_from && !v.view_field_owners?.size) continue;
		const field_borrows = v.has_view_borrows && !!v.view_field_owners?.has(owner);
		if (v.borrowed_from === owner && v.type?.is_view) {
			// With a declared field-effect set (FIELD_EFFECTS.md), only the
			// borrows taken through a declared field die; a view slice
			// borrowed from another field of the same owner survives.
			if (fields === undefined || declared_fields_cover_path(fields, v.borrowed_via)) {
				v.borrow_invalidated = true;
			}
		} else if (field_borrows) {
			if (!status.invalidated_view_structs) status.invalidated_view_structs = new Set();
			status.invalidated_view_structs.add(v.name);
		}
	}
}

/**
 * Mark every live child-group borrow rooted at `owner` as invalidated, because
 * a `ref self` / `var self` call on (or mv-field assignment to) `owner` may
 * free or displace the contents those borrows point into. Reading an
 * invalidated borrow is rejected later in check_value_node. View-field borrows
 * (struct values with view_field_owners) are handled by the view-specific
 * invalidator above — this pass must not poison the whole struct variable for
 * uses of its non-view fields.
 */
/**
 * Mark every live child-group borrow rooted at `owner` as invalidated, because
 * a `ref self` / `var self` call on (or mv-field assignment to) `owner` may
 * free or displace the contents those borrows point into. Reading an
 * invalidated borrow is rejected later in check_value_node. View-field borrows
 * (struct values with view_field_owners) are handled by the view-specific
 * invalidator above — this pass must not poison the whole struct variable for
 * uses of its non-view fields.
 *
 * With a declared field set (FIELD_EFFECTS.md — the callee's
 * `{ … }` set), only the borrows taken through a declared field
 * die; sibling-field borrows stay live. Borrows with no stamped path are
 * still poisoned conservatively. `undefined` keeps today's whole-owner
 * behavior (un-annotated mutators are wildcards).
 */
export function invalidate_borrows_of(status: CheckStatus, owner: string, fields?: string[]) {
	for (const v of status.values) {
		if (v.borrowed_from === owner && !v.has_view_borrows) {
			if (fields === undefined || declared_fields_cover_path(fields, v.borrowed_via)) {
				v.borrow_invalidated = true;
			}
		}
	}
	// A ref-mutation of an owner also invalidates struct view-field borrows.
	invalidate_view_borrows_of(status, owner, fields);
}

/**
 * Revert every live hoisted ELEMENT-BORROW receiver temp rooted at `owner`
 * (or the alias `name` itself) back to the owning temp the `_recv_N` hoist
 * would have made. The element borrow is a perf elision: the alias reads the
 * container's slot directly, which stays invisible to the program only while
 * nothing mutates through (or around) it. A mutation reverts the hoist — the
 * decl goes back to the owning copy (`is_ref_binding` cleared, the call back
 * to `at`/`get_or_panic`), so the build emits the deep copy an owning read
 * made and the mutation writes the temp, exactly the pre-change semantics.
 * Reads already checked against the alias stay valid: both forms share the
 * temp's name and type, so no re-check is needed.
 *
 * The hoisted temps never enter `status.values` (they resolve through their
 * stamped ValueNode type), so there is no StackValue to unmark here.
 */
export function revert_hoisted_element_borrows(status: CheckStatus, owner: string, name?: string) {
	const hoisted = status.hoisted_element_borrows;
	if (!hoisted?.size) return;
	for (const [temp_name, entry] of hoisted) {
		if (name !== undefined && temp_name !== name) continue;
		if (name === undefined && entry.owner !== owner) continue;
		revert_element_borrow_decl(entry.decl);
		hoisted.delete(temp_name);
	}
}

/** Restore a hoisted borrow decl to the owning-temp form (idempotent). */
export function revert_element_borrow_decl(decl: import("../../nodes/DeclarationNode.ts").default) {
	if (!decl.is_ref_binding) return;
	decl.is_ref_binding = false;
	const value = decl.value;
	if (value?.node_type === "access") {
		const call = (value as import("../../nodes/AccessNode.ts").default)
			.access as import("../../nodes/AccessFunctionCallNode.ts").default;
		if (call.node_type === "access_func") {
			// Reverse of the slot-load rewrite: the primitive name back to the
			// read spelling the call was checked as.
			call.name = call.name === "get_ptr" ? "get_or_panic" : "at";
			call.is_element_slot_load = false;
		}
	}
}

/**
 * Carry borrow invalidations performed inside a cloned branch status back into
 * the enclosing status. A borrow invalidated in any branch that can fall
 * through (or any loop-body iteration) is considered invalidated afterwards —
 * a conservative union, since either path may have executed. Without this,
 * invalidations vanish with the discarded branch clone and the borrow could be
 * read after the block.
 */
export function persist_invalidated(status: CheckStatus, branch: CheckStatus) {
	for (let i = 0; i < status.values.length; i++) {
		if (branch.values[i]?.borrow_invalidated) {
			status.values[i].borrow_invalidated = true;
		}
	}
}
