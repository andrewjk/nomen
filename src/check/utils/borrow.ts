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
 *    — a non-owning slice that borrows from the receiver;
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
			// Reading a `view T` FIELD yields a non-owning slice whose validity
			// is rooted at the struct instance it was read from (the instance's
			// own borrow depth covers its fields' sources).
			if (t?.is_view && access.target.node_type === "value") {
				const base = status.values.findLast((v) => v.name === (access.target as ValueNode).value);
				return Math.max(base?.borrow_depth ?? 0, status.scope_depth);
			}
		} else if (access.access.node_type === "access_func") {
			const t = type_from_value_node(access, status);
			if (is_borrowed_return(t, status)) {
				// A `mov out T` method transfers ownership — the result is an
				// owned value, not a borrow.
				if ((access.access as AccessFunctionCallNode).owned_return) return undefined;
				// Instance method returning a class/view borrows from its
				// receiver. Static calls (receiver is a type name, not a
				// variable in scope) and constructors produce owned values.
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
			if (is_borrowed_return(t, status)) {
				// A `mov out T` method returns an owned value — no owner to root
				// a borrow at (and it must not be invalidated by receiver mutation).
				if ((access.access as AccessFunctionCallNode).owned_return) return undefined;
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
				// on a field path — root the borrow at the ultimate owning var.
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
 * false for primitives, constructors, and `mov out T` (owned) returns. Traits
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
 * Resolve an access target down to its ultimate owning variable name. Recurses
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
export function invalidate_view_borrows_of(status: CheckStatus, owner: string) {
	for (const v of status.values) {
		if (!v.borrowed_from && !v.view_field_owners?.size) continue;
		const field_borrows = v.has_view_borrows && !!v.view_field_owners?.has(owner);
		if (v.borrowed_from === owner && v.type?.is_view) {
			v.borrow_invalidated = true;
		} else if (field_borrows) {
			if (!status.invalidated_view_structs) status.invalidated_view_structs = new Set();
			status.invalidated_view_structs.add(v.name);
		}
	}
}

/**
 * Mark every live child-group borrow rooted at `owner` as invalidated, because
 * a `ref self` / `var self` call on (or owning-field assignment to) `owner` may
 * free or displace the contents those borrows point into. Reading an
 * invalidated borrow is rejected later in check_value_node. View-field borrows
 * (struct values with view_field_owners) are handled by the view-specific
 * invalidator above — this pass must not poison the whole struct variable for
 * uses of its non-view fields.
 */
export function invalidate_borrows_of(status: CheckStatus, owner: string) {
	for (const v of status.values) {
		if (v.borrowed_from === owner && !v.has_view_borrows) {
			v.borrow_invalidated = true;
		}
	}
	// A ref-mutation of an owner also invalidates struct view-field borrows.
	invalidate_view_borrows_of(status, owner);
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
