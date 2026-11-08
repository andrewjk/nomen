import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import type Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import { borrow_depth_of, borrow_owner_of } from "./borrow.ts";

/**
 * Whether the named struct (or any value struct embedded in its fields,
 * recursively) declares a `view T` field. A struct with view fields carries
 * non-mv borrows inside its bytes, which drives the borrow rules:
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
 * borrow so escape checks stay conservative across multiple fields.
 *
 * `opts` refines the recording and the staleness clearing:
 *  - `field` — a direct `root.field = …` store: the field's owner is
 *    recorded precisely (`view_field_source_of`), so a later mutation of
 *    that owner poisons only this field; a re-point clears this field's
 *    staleness (precise tier only — sibling staleness survives, which the
 *    old whole-instance refresh got wrong). Owners that cannot be
 *    attributed (multiple/none) are marked unattributed instead.
 *  - `sources` — per-field owner attribution for a WHOLE freshly-built
 *    value (a constructor path, keyed by the struct's field names).
 *  - `fresh` — the stored value is freshly constructed, so every view field
 *    was re-pointed: wholesale staleness for the root clears (both tiers).
 * Without `opts` (embedded merges) owners join the union unattributed and
 * nothing clears — today's wholesale behavior, minus the over-eager refresh.
 */
export function merge_view_borrows_into_var(
	root: string | undefined,
	infos: Map<string, BorrowInfo> | undefined,
	status: CheckStatus,
	opts?: {
		field?: string;
		sources?: Map<string, string> | undefined;
		fresh?: boolean;
	},
) {
	if (!root || !infos || infos.size === 0) return;
	const sv = status.values.findLast((v) => v.name === root);
	if (!sv) return;
	sv.has_view_borrows = true;
	if (!sv.view_field_owners) sv.view_field_owners = new Set<string>();
	const prev_owner = opts?.field ? sv.view_field_source_of?.get(opts.field) : undefined;
	for (const [owner, info] of infos) {
		if (owner) sv.view_field_owners.add(owner);
		if (info.depth !== undefined) {
			sv.borrow_depth =
				sv.borrow_depth === undefined ? info.depth : Math.min(sv.borrow_depth, info.depth);
		}
	}
	// Attribution bookkeeping: the precise records drive per-field
	// invalidation; anything unattributable keeps the wholesale tier.
	if (opts?.sources?.size) {
		if (!sv.view_field_source_of) sv.view_field_source_of = new Map();
		for (const [field, owner] of opts.sources) {
			sv.view_field_source_of.set(field, owner);
			sv.view_field_owners.add(owner);
		}
	} else if (opts?.field) {
		const owners = [...infos.keys()].filter((o) => o);
		if (owners.length === 1) {
			const owner = owners[0];
			if (!sv.view_field_source_of) sv.view_field_source_of = new Map();
			sv.view_field_source_of.set(opts.field, owner);
			// The field no longer borrows its previous owner: retire that
			// owner from the union when nothing else references it.
			if (
				prev_owner &&
				prev_owner !== owner &&
				![...sv.view_field_source_of.values()].includes(prev_owner) &&
				!sv.view_field_unattributed_owners?.has(prev_owner)
			) {
				sv.view_field_owners.delete(prev_owner);
			}
		} else {
			if (!sv.view_field_unattributed_owners) sv.view_field_unattributed_owners = new Set();
			for (const owner of owners) sv.view_field_unattributed_owners.add(owner);
		}
	} else {
		if (!sv.view_field_unattributed_owners) sv.view_field_unattributed_owners = new Set();
		for (const owner of infos.keys()) {
			if (owner) sv.view_field_unattributed_owners.add(owner);
		}
	}
	if (opts?.fresh) {
		// A freshly-built value re-points every view field: all staleness
		// (wholesale and precise) clears.
		status.invalidated_view_structs?.delete(root);
		status.invalidated_view_fields?.delete(root);
	} else if (opts?.field) {
		// A direct store re-points exactly this field.
		status.invalidated_view_fields?.get(root)?.delete(opts.field);
	}
}

/**
 * Per-field owner attribution for a constructor call's `view T` arguments
 * (`Pair(a.slice(0, 2), b.slice(0, 2))` → `{first: "a", second: "b"}`): the
 * i-th view param maps to the struct's i-th field (ctor params mirror the
 * field order). Returns undefined when ANY piece cannot be attributed — an
 * unresolvable struct, a non-field-mapped param, an ownerless source — so
 * the caller keeps the wholesale fallback instead of a half-precise record.
 */
export function ctor_call_view_field_sources(
	call: FunctionCallNode,
	status: CheckStatus,
): Map<string, string> | undefined {
	const indices = call.view_param_indices ?? [];
	if (!indices.length) return undefined;
	const struct = status.structs.find((s) => s.name === call.name && !s.is_simple_type);
	if (!struct) return undefined;
	let out: Map<string, string> | undefined;
	for (const i of indices) {
		let arg = call.params[i];
		if (!arg) return undefined;
		// A hoisted temp argument: resolve the original initializer, same as
		// ctor_call_view_borrow.
		if (arg.node_type === "value") {
			const name = (arg as ValueNode).value;
			const hoisted =
				(call.allocations as DeclarationNode[] | undefined)?.findLast((d) => d.name === name) ??
				status.allocations.findLast((d) => d.name === name);
			if (hoisted?.value) arg = hoisted.value;
		}
		const info = view_source_borrow_info(arg, status);
		const field = struct.fields[i];
		if (!info?.owner || !field || !field.type.is_view) return undefined;
		if (!out) out = new Map();
		out.set(field.name, info.owner);
	}
	return out;
}

/**
 * A direct store from an unconditional source (a literal / const) re-points
 * exactly that field: clear its precise staleness. Wholesale staleness
 * (unattributed dependencies) intentionally survives — the store says
 * nothing about the fields it didn't write.
 */
export function refresh_view_field(root: string | undefined, field: string, status: CheckStatus) {
	if (!root) return;
	status.invalidated_view_fields?.get(root)?.delete(field);
}

/**
 * A byte-copy of a view-carrying struct aliases the same sources — and the
 * same staleness. Mirror the source's poison onto the copy's name: wholesale
 * stays wholesale; precise fields copy precisely. (Without this, a copy of a
 * poisoned struct would read as fresh — the poison is keyed on the variable
 * name, and the copy has a new one.)
 */
export function propagate_view_field_poison(
	src_name: string,
	dst_name: string,
	status: CheckStatus,
) {
	if (src_name === dst_name) return;
	if (status.invalidated_view_structs?.has(src_name)) {
		if (!status.invalidated_view_structs) status.invalidated_view_structs = new Set();
		status.invalidated_view_structs.add(dst_name);
	}
	const precise = status.invalidated_view_fields?.get(src_name);
	if (precise?.size) {
		if (!status.invalidated_view_fields) status.invalidated_view_fields = new Map();
		status.invalidated_view_fields.set(dst_name, new Set(precise));
	}
}

/**
 * Propagate view-field borrow state when a struct value is copied
 * (`b = a`, `var Line b = a`): the copy aliases the same sources, so it
 * depends on exactly the same owners and inherits the tightest depth. The
 * per-field attribution and the unattributed marks copy too — the copy's
 * fields alias the same sources field-for-field.
 */
export function propagate_view_borrows(
	target: {
		has_view_borrows?: boolean;
		view_field_owners?: Set<string>;
		view_field_source_of?: Map<string, string>;
		view_field_unattributed_owners?: Set<string>;
		borrow_depth?: number;
	},
	source: {
		has_view_borrows?: boolean;
		view_field_owners?: Set<string>;
		view_field_source_of?: Map<string, string>;
		view_field_unattributed_owners?: Set<string>;
		borrow_depth?: number;
	},
) {
	if (!source.has_view_borrows) return;
	target.has_view_borrows = true;
	if (source.view_field_owners?.size) {
		if (!target.view_field_owners) target.view_field_owners = new Set<string>();
		for (const owner of source.view_field_owners) target.view_field_owners.add(owner);
	}
	if (source.view_field_source_of?.size) {
		if (!target.view_field_source_of) target.view_field_source_of = new Map();
		for (const [field, owner] of source.view_field_source_of) {
			target.view_field_source_of.set(field, owner);
		}
	}
	if (source.view_field_unattributed_owners?.size) {
		if (!target.view_field_unattributed_owners) target.view_field_unattributed_owners = new Set();
		for (const owner of source.view_field_unattributed_owners) {
			target.view_field_unattributed_owners.add(owner);
		}
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
 * Whether a value of this type can carry a non-mv view borrow: the type
 * itself is a `view`, a `ref` (a borrow by definition — keep the existing
 * taint), a struct declaring (transitively) `view T` fields, or a generic
 * instantiation with such an argument. Anything else (primitives, owned
 * strings, containers of owned values) owns its storage outright, so a call
 * producing it does not propagate its view arguments' borrows — tainting it
 * is a false positive (e.g. returning `slice_string(view)` from a function
 * returning owned `string`). Callers pass an unset/unknown type through as
 * carrying, preserving today's behavior where nothing is known.
 */
export function type_can_carry_view_borrow(type: Type | undefined, status: CheckStatus): boolean {
	if (!type || !type.name) return true;
	if (type.is_view || type.is_ref) return true;
	if (struct_has_view_fields(type.name, status)) return true;
	return (type.type_args ?? []).some((t) => type_can_carry_view_borrow(t, status));
}

/**
 * Whether reading view fields of `root` is currently rejected because their
 * source was mutated (reassigned / ref-mutated). `field` narrows to the
 * precise tier: only the named field's staleness counts — the wholesale tier
 * (unattributed dependencies) rejects any field of the root.
 */
export function view_fields_invalidated(
	root: string | undefined,
	status: CheckStatus,
	field?: string,
): boolean {
	if (!root) return false;
	if (status.invalidated_view_structs?.has(root)) return true;
	if (field && status.invalidated_view_fields?.get(root)?.has(field)) return true;
	return false;
}
