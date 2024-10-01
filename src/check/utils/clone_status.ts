import type CheckStatus from "../CheckStatus";

/**
 * Clones a status for passing down to checking in a block and discarding afterwards
 */
export default function clone_status(status: CheckStatus): CheckStatus {
  return {
    stack: status.stack,
    types: status.types,
    expected_type: status.expected_type,
    // Clone values, so that we can check whether is_set is set in all branches
    values: status.values.map((v) => ({ ...v })),
    // Clone struct, trait and function arrays so that they can be reset when exiting a block
    structs: status.structs.slice(),
    traits: status.traits.slice(),
    functions: status.functions.slice(),
    errors: status.errors,
  };
}
