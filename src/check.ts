import built_in_types from "./built_in_types.ts";
import check_node from "./check/check_node.ts";
import type CheckStatus from "./check/CheckStatus.ts";
import BaseNode from "./nodes/BaseNode.ts";
import type CheckResult from "./types/CheckResult.ts";

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
		type_params: [],
		errors: [],
	};

	check_node(root, status);

	return {
		ok: !status.errors.length,
		errors: status.errors,
	};
}
