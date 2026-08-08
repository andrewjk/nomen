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
		})),
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
		// Buffer cap tracking: share the same map (writes propagate to parent)
		buffer_caps: status.buffer_caps,
		// Mutating-call tracking: share the same set so records in cloned
		// (block/function) scopes propagate to the root warning pass.
		mutated_local_names: status.mutated_local_names,
	};
}
