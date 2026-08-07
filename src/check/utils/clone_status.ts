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
		// Clone values, so that we can check whether is_set is set in all branches
		values: status.values.map((v) => ({ ...v })),
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
