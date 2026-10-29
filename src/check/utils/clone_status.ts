import type CheckStatus from "../CheckStatus.ts";

/**
 * Clones a status for passing down to checking in a block and discarding afterwards
 */
export default function clone_status(status: CheckStatus): CheckStatus {
	return {
		stack: status.stack,
		scope_depth: status.scope_depth,
		types: status.types,
		expected_type: status.expected_type,
		// Clone values, so that we can check whether is_set is set in all branches.
		// Deep-copy the flow-sensitive bound arrays too — otherwise an
		// `apply_bounds`/`apply_negated_bounds` call on a cloned branch (an if
		// body, a while body) mutates the arrays the parent still holds, leaking
		// branch-local facts outwards (e.g. a guard-clause's negation pollutes the
		// parent and suppresses a later guard). The reconciliation in
		// check_if_else_node/check_while_loop_node is responsible for propagating
		// the surviving bounds back to the parent explicitly.
		values: status.values.map((v) => ({
			...v,
			upper_bound_exprs: v.upper_bound_exprs?.slice(),
			lower_bound_exprs: v.lower_bound_exprs?.slice(),
			upper_bound_inclusive_exprs: v.upper_bound_inclusive_exprs?.slice(),
			lower_bound_inclusive_exprs: v.lower_bound_inclusive_exprs?.slice(),
			path_bounds: v.path_bounds
				? new Map(
						[...v.path_bounds].map(([k, b]) => [
							k,
							{
								upper: b.upper?.slice(),
								lower: b.lower?.slice(),
								upper_inclusive: b.upper_inclusive?.slice(),
								lower_inclusive: b.lower_inclusive?.slice(),
								range_lower: b.range_lower,
								range_upper: b.range_upper,
							},
						]),
					)
				: undefined,
		})),
		// Devirtualization rebind scan: shared by reference — the scan is
		// immutable once a function entry computes it, so block clones (if /
		// while / match bodies) must see the same set. check_function_node
		// assigns a fresh scan for each nested function.
		devirt_rebound_names: status.devirt_rebound_names,
		// Inherited from the current function: block clones (if/else/while)
		// stay in the same function, so they keep the enclosing base. Only
		// `check_function_node` resets it for a freshly-entered function.
		function_value_base: status.function_value_base,
		// Clone struct, trait and function arrays so that they can be reset when exiting a block
		structs: status.structs.slice(),
		traits: status.traits.slice(),
		enums: status.enums.slice(),
		bitsets: status.bitsets.slice(),
		functions: status.functions.slice(),
		// Unwound declarations get added to until flushed
		allocations: status.allocations,
		var_name_counter: status.var_name_counter,
		type_params: status.type_params,
		errors: status.errors,
		// Share the warnings array like errors: a lint recorded inside a
		// cloned (block/function) scope must survive the clone's discard and
		// reach the root's warning pass.
		warnings: status.warnings,
		// Buffer cap tracking: share the same map (writes propagate to parent)
		buffer_caps: status.buffer_caps,
		// Parallel-length equations: block clones stay in the same function,
		// so carry a copy (blocks never write; the copy is only for reads).
		// check_function_node resets this for a freshly-entered function.
		equal_lengths: status.equal_lengths?.slice(),
		// Mutating-call tracking: share the same set so records in cloned
		// (block/function) scopes propagate to the root warning pass.
		mutated_local_names: status.mutated_local_names,
		// Unsafe context: block clones (if/else/while bodies) stay inside the
		// same unsafe function, so inherit the flag.
		in_unsafe: status.in_unsafe,
		// View-field invalidations: share the same set so an invalidation
		// inside a branch (which may fall through) stays visible afterwards —
		// a conservative union, mirroring mutated_local_names.
		invalidated_view_structs: status.invalidated_view_structs,
		// May-be-null paths: deep-copy so a branch's `== null` narrowing (or a
		// null assignment) doesn't leak into the parent (or a sibling branch).
		// check_if_else_node reconciles the survivors explicitly.
		null_paths: status.null_paths ? new Set(status.null_paths) : undefined,
		// Nested-function label uniquification must see every emission name
		// in the program — share the same set across all clones.
		function_emission_names: status.function_emission_names,
		// Nested-type label uniquification: same discipline as functions.
		type_name_counts: status.type_name_counts,
		type_emission_names: status.type_emission_names,
		// Trusted-internal opt-in: a build-wide flag, inherited by every clone.
		allow_internal: status.allow_internal,
		library_boundary: status.library_boundary,
		// Nursery context: block clones (if/else/while inside `async { }`)
		// stay inside the same nursery, so both the depth and the stack of
		// body scope depths carry into every clone (spawn_region.ts reads
		// them at spawn constructions nested in branch/loop bodies). The
		// frozen-root sets are shared BY REFERENCE (only the array is
		// copied): a freeze made inside a branch lasts until the block
		// exits, and the frame dies with this clone's discard.
		nursery_depth: status.nursery_depth,
		nursery_scope_depths: status.nursery_scope_depths?.slice(),
		nursery_frozen_roots: status.nursery_frozen_roots?.slice(),
	};
}
