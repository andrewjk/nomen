import type BaseNode from "../nodes/BaseNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import { owns_strings_uniformly } from "./has_string_fields.ts";
import {
	in_place_field_path_owners,
	in_place_field_path_root_struct_name,
	in_place_receiver_path,
} from "./in_place_push.ts";

/**
 * The ownership state of a caller slot about to be passed as a `ref string`
 * argument. The callee may ASSIGN through the pointer (assignment value
 * semantics), displacing the slot's current pair — and the CALLEE cannot
 * know that pair's ownership (it sees a `nomen_string *`). The caller does:
 * these plans tell the backends whether the displaced pair may be freed.
 */
export type RefStringSlotPlan =
	/** A full-owner string local: free the displaced pair after the call. */
	| { kind: "owned_local"; name: string }
	/** A `root.<field>` one-hop field whose displaced pair is provably
	 *  heap-owned — either the container's string fields are uniformly heap
	 *  (a class, an owning/mv struct: the scope-exit destroy frees them
	 *  unconditionally) or the per-assignment heap record vouches for it. */
	| { kind: "owned_field"; access: string }
	/** The slot currently holds bytes the caller does not own (a borrow
	 *  local, or — on a backend that keeps literal inits as rodata — a
	 *  literal-initialized local): freeing would reclaim foreign memory.
	 *  The caller must not free; the slot ADOPTS the callee's new owned
	 *  value, and `mark_heap` records the new ownership so the scope-exit
	 *  free releases it. */
	| { kind: "adopting_local"; name: string; mark_heap: boolean }
	/** The slot's ownership is unknown (nested chains, index hops, chained
	 *  `ref` args) — leave the status quo in place (bounded leak). */
	| undefined;

interface RefStringStatusShape {
	scoped_declarations: { name: string; type?: Type }[];
	string_borrow_vars?: Set<string>;
	force_heap_strings?: Set<string>;
	heap_strings?: Set<string>;
	owned_string_vars?: Set<string>;
	variable_types?: Map<string, Type>;
	heap_string_fields?: Set<string>;
	structs: StructNode[];
	current_struct?: { name?: string };
}

/**
 * Classify a `ref string` argument's slot. `arg` is the caller-side argument
 * expression (a bare name or a field-access chain — the checker rejects
 * everything else for `ref` args). `declares_own_literals` says whether the
 * backend strdup's literal string initializers into heap copies (the C
 * backend does — every string local owns heap from birth); when false (the
 * aarch64 backend stores the raw rodata pair), a local owns its pair only
 * once the heap-ownership records say so, and a literal-initialized slot
 * adopts instead. Returns undefined when the slot's ownership cannot be
 * vouched for.
 */
export function ref_string_slot_plan(
	arg: BaseNode,
	status: RefStringStatusShape,
	declares_own_literals: boolean,
): RefStringSlotPlan {
	if (arg.node_type === "value") {
		const name = (arg as { value?: unknown }).value;
		if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
		const decl = [...status.scoped_declarations].reverse().find((d) => d.name === name);
		const declared =
			decl?.type ?? status.variable_types?.get(name) ?? (arg as { type?: Type }).type;
		if (!declared || declared.name !== "string" || declared.is_view || declared.is_array) {
			return undefined;
		}
		// A borrow-initialized local holds bytes someone else owns — freeing
		// would reclaim them. (A force-heap borrow local was converted to a
		// full owner at its declaration; force_heap_strings vouches for it.)
		const borrow_without_heap =
			status.string_borrow_vars?.has(name) && !status.force_heap_strings?.has(name);
		if (borrow_without_heap) return { kind: "adopting_local", name, mark_heap: true };
		const heap_vouched =
			status.heap_strings?.has(name) ||
			status.force_heap_strings?.has(name) ||
			status.owned_string_vars?.has(name);
		const owns = declares_own_literals ? !!decl || heap_vouched : heap_vouched;
		if (owns) return { kind: "owned_local", name };
		// Not vouched (an untracked or rodata-backed slot): adopt — the new
		// value must be recorded as heap-owned so scope exit frees it.
		if (decl || declared.name === "string") {
			return { kind: "adopting_local", name, mark_heap: true };
		}
		return undefined;
	}
	if (arg.node_type !== "access") return undefined;
	const path = in_place_receiver_path(arg);
	if (!path || path.fields.length !== 1) return undefined;
	const root_struct_name = in_place_field_path_root_struct_name(status, path.root);
	if (!root_struct_name) return undefined;
	const walk = in_place_field_path_owners(root_struct_name, path.fields, status.structs);
	if (!walk) return undefined;
	const container_name = walk.owners[walk.owners.length - 1];
	const container = status.structs.find((s) => s.name === container_name && !s.is_generic);
	if (!container) return undefined;
	const access = `${path.root}.${path.fields[0]}`;
	// A class or owning (mv) struct's string fields are uniformly heap: the
	// scope-exit destroy frees them unconditionally, so the displaced pair
	// is reclaimable without a record. A plain value struct needs the
	// per-assignment heap record; without it the pair may be rodata.
	const always_heap = container.is_class || owns_strings_uniformly(container);
	if (always_heap) return { kind: "owned_field", access };
	if (status.heap_string_fields?.has(access)) return { kind: "owned_field", access };
	return undefined;
}
