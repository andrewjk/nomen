import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import { borrow_depth_of, borrow_owner_of } from "./borrow.ts";

/**
 * Whether the named struct (or any value struct embedded in its fields,
 * recursively) declares a `view T` field. A struct with view fields carries
 * non-owning borrows inside its bytes, which drives the borrow rules:
 * copies are sound (a pair copy aliases nothing owned), but escapes
 * (returning, outer-scope assignment) are checked against where those
 * borrows were taken.
 */
export function struct_has_view_fields(
	type_name: string | undefined,
	status: CheckStatus,
): boolean {
	if (!type_name) return false;
	const struct = status.structs.find((s) => s.name === type_name && !s.is_simple_type);
	return !!struct && has_view_fields(struct, status, new Set());
}

function has_view_fields(struct: StructNode, status: CheckStatus, visited: Set<string>): boolean {
	if (visited.has(struct.name)) return false;
	visited.add(struct.name);
	for (const field of struct.fields) {
		if (field.type.is_view) return true;
		if (field.type.is_ref || field.type.is_array) continue;
		const field_struct = status.structs.find(
			(s) => s.name === field.type.name && !s.is_simple_type && !s.is_class,
		);
		if (field_struct && has_view_fields(field_struct, status, visited)) return true;
	}
	return false;
}

/**
 * The root variable an access chain bottoms out at (`line.text` → "line",
 * `a.b.c` → "a", bare `x` → "x"). Returns undefined when the chain does not
 * bottom out in a plain name (e.g. a call receiver).
 */
export function root_var_of(node: BaseNode): string | undefined {
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		return name === "null" ? undefined : name;
	}
	if (node.node_type === "access") {
		return root_var_of((node as AccessNode).target);
	}
	return undefined;
}

export interface BorrowInfo {
	depth?: number;
	owner?: string;
}

/**
 * Where a view value stored into a field borrows from.
 *
 *  - A `.slice()`-style view expression: borrow_depth/borrow_owner give the
 *    scope depth and owner variable (the slice's receiver).
 *  - A bare variable of owned type (`view string f = doc`): borrowing it is
 *    the identity on fat strings, but it creates a real dependency — record
 *    the source's own declaration depth and name so reassignment of the
 *    source invalidates the field.
 *  - A literal / const: static storage that outlives everything — no borrow.
 *
 * Returns undefined for sources that impose no dependency.
 */
export function view_source_borrow_info(
	node: BaseNode,
	status: CheckStatus,
): BorrowInfo | undefined {
	// Static literals (rodata) live for the whole program.
	if (node.node_type === "value" && (node as ValueNode).value.startsWith('"')) return undefined;

	const depth = borrow_depth_of(node, status);
	const owner = borrow_owner_of(node, status);
	if (depth !== undefined || owner !== undefined) {
		return { depth: depth ?? status.scope_depth, owner };
	}

	// A bare owned variable: the field now borrows from that variable itself.
	if (node.node_type === "value") {
		const decl = status.values.findLast((v) => v.name === (node as ValueNode).value);
		if (decl && !decl.is_null) {
			return { depth: decl.decl_depth ?? 0, owner: decl.name };
		}
		// A hoisted call argument (the checker rewrites `Line(doc.slice(…))`
		// into `var _param_0 = doc.slice(…); Line(_param_0)`): the temp's
		// declare may not be checked/pushed into status.values yet at the
		// time the constructor's borrow info is computed, so resolve through
		// the pending allocation and classify its initializer instead.
		const alloc = status.allocations.findLast((d) => d.name === (node as ValueNode).value);
		if (alloc?.value) {
			return view_source_borrow_info(alloc.value, status);
		}
	}
	return undefined;
}

/**
 * Borrow info contributed by a constructor call's `view T` arguments (e.g.
 * `Line(doc.slice(0, 5), 0, 5)`): merges every view-typed argument's borrow
 * into one entry per distinct owner (the tightest depth wins). Returns
 * undefined when the call passes no dependent views.
 */
export function ctor_call_view_borrow(
	call: FunctionCallNode,
	status: CheckStatus,
): Map<string, BorrowInfo> | undefined {
	const indices = call.view_param_indices ?? [];
	let merged: Map<string, BorrowInfo> | undefined;
	for (const i of indices) {
		let arg = call.params[i];
		if (!arg) continue;
		// A hoisted temp argument (`Line(doc.slice(…))` becomes
		// `var _param_0 = doc.slice(…); Line(_param_0)`): the temp's declare
		// may not be in status.values yet, so resolve through the call's own
		// allocation declares (or the status's pending ones) and classify the
		// original initializer instead.
		if (arg.node_type === "value") {
			const name = (arg as ValueNode).value;
			const hoisted =
				(call.allocations as DeclarationNode[] | undefined)?.findLast((d) => d.name === name) ??
				status.allocations.findLast((d) => d.name === name);
			if (hoisted?.value) arg = hoisted.value;
		}
		const info = view_source_borrow_info(arg, status);
		if (!info) continue;
		if (!merged) merged = new Map();
		merge_borrow_info(merged, info);
	}
	return merged;
}

/** Fold one borrow into the per-owner map, keeping the tightest depth. */
function merge_borrow_info(map: Map<string, BorrowInfo>, info: BorrowInfo) {
	const key = info.owner ?? "";
	const existing = map.get(key);
	if (!existing) {
		map.set(key, { ...info });
		return;
	}
	if (info.depth !== undefined && (existing.depth === undefined || info.depth < existing.depth)) {
		existing.depth = info.depth;
	}
}

/**
 * Record that view values were stored into fields of the struct variable
 * `root`: the instance now carries borrows rooted at each owner with the
 * given scope depths. Depth tracking keeps the tightest (deepest-rooted)
 * borrow so escape checks stay conservative across multiple fields. Also
 * clears any stale invalidation for the root — the fresh store re-points a
 * field (approximation: any view-field store refreshes the whole instance).
 */
export function merge_view_borrows_into_var(
	root: string | undefined,
	infos: Map<string, BorrowInfo> | undefined,
	status: CheckStatus,
) {
	if (!root || !infos || infos.size === 0) return;
	const sv = status.values.findLast((v) => v.name === root);
	if (!sv) return;
	sv.has_view_borrows = true;
	if (!sv.view_field_owners) sv.view_field_owners = new Set<string>();
	for (const [owner, info] of infos) {
		if (owner) sv.view_field_owners.add(owner);
		if (info.depth !== undefined) {
			sv.borrow_depth =
				sv.borrow_depth === undefined ? info.depth : Math.min(sv.borrow_depth, info.depth);
		}
	}
	// Re-pointing any view field refreshes the instance's staleness.
	status.invalidated_view_structs?.delete(root);
}

/**
 * Propagate view-field borrow state when a struct value is copied
 * (`b = a`, `var Line b = a`): the copy aliases the same sources, so it
 * depends on exactly the same owners and inherits the tightest depth.
 */
export function propagate_view_borrows(
	target: { has_view_borrows?: boolean; view_field_owners?: Set<string>; borrow_depth?: number },
	source: { has_view_borrows?: boolean; view_field_owners?: Set<string>; borrow_depth?: number },
) {
	if (!source.has_view_borrows) return;
	target.has_view_borrows = true;
	if (source.view_field_owners?.size) {
		if (!target.view_field_owners) target.view_field_owners = new Set<string>();
		for (const owner of source.view_field_owners) target.view_field_owners.add(owner);
	}
	if (
		source.borrow_depth !== undefined &&
		(target.borrow_depth === undefined || source.borrow_depth < target.borrow_depth)
	) {
		target.borrow_depth = source.borrow_depth;
	}
}

/**
 * Whether every recorded view-field borrow of the value roots at `self`
 * (the receiver) — the same re-rooting convention that lets a `slice`
 * method return its view: the caller re-roots the borrow at the call-site
 * receiver.
 */
export function view_borrows_root_at_self(sv: { view_field_owners?: Set<string> }): boolean {
	const owners = sv.view_field_owners;
	return !!owners?.size && [...owners].every((o) => o === "self");
}

/**
 * Whether reading view fields of `root` is currently rejected because their
 * source was mutated (reassigned / ref-mutated).
 */
export function view_fields_invalidated(root: string | undefined, status: CheckStatus): boolean {
	if (!root) return false;
	return !!status.invalidated_view_structs?.has(root);
}
