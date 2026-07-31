import built_in_types from "./built_in_types.ts";
import check_node from "./check/check_node.ts";
import type CheckStatus from "./check/CheckStatus.ts";
import emit_warnings from "./check/warnings.ts";
import BaseNode from "./nodes/BaseNode.ts";
import type CheckResult from "./types/CheckResult.ts";

export default function check(root: BaseNode): CheckResult {
	const status: CheckStatus = {
		stack: [root],
		scope_depth: 0,
		values: [],
		types: [...built_in_types],
		structs: [],
		enums: [],
		bitsets: [],
		traits: [],
		functions: [],
		allocations: [],
		var_name_counter: { value: 0 },
		type_params: [],
		errors: [],
		warnings: [],
		buffer_caps: new Map(),
	};

	check_node(root, status);

	// Only analyse for warnings on a clean check — a partially-checked,
	// erroring tree would surface misleading or spurious warnings.
	if (!status.errors.length) emit_warnings(root, status);

	return {
		ok: !status.errors.length,
		errors: status.errors,
		warnings: status.warnings ?? [],
	};
}
