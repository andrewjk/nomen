import built_in_types from "./built_in_types";
import type CheckStatus from "./check/CheckStatus";
import check_node from "./check/check_node";
import BaseNode from "./nodes/BaseNode";
import type CheckResult from "./types/CheckResult";

export default function check(root: BaseNode): CheckResult {
  const status: CheckStatus = {
    stack: [root],
    values: [],
    types: [...built_in_types],
    structs: [],
    traits: [],
    functions: [],
    allocations: [],
    var_name_counter: { value: 0 },
    errors: [],
  };

  check_node(root, status);

  return {
    ok: !status.errors.length,
    errors: status.errors,
  };
}
