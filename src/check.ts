import built_in_types from "./built_in_types.ts";
import check_node from "./check/check_node.ts";
import type CheckStatus from "./check/CheckStatus.ts";
import stamp_hidden_string_lens from "./check/stamp_hidden_string_lens.ts";
import emit_warnings from "./check/warnings.ts";
import BaseNode from "./nodes/BaseNode.ts";
import type RootNode from "./nodes/RootNode.ts";
import type CheckResult from "./types/CheckResult.ts";

export default function check(root: BaseNode): CheckResult {
	const status: CheckStatus = {
		stack: [root],
		scope_depth: 0,
		values: [],
		function_value_base: 0,
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
		mutated_local_names: new Set(),
	};

	check_node(root, status);

	// Stamp hidden string-length companion params (PERF gap 2.4): by-value
	// `string` params whose body reads `.length` gain a trailing length
	// companion in the ABI, threaded through every call site. Runs after the
	// full tree is checked so body facts and func-value references are final.
	stamp_hidden_string_lens(root as RootNode, status);

	// Only analyse for warnings on a clean check — a partially-checked,
	// erroring tree would surface misleading or spurious warnings.
	if (!status.errors.length) emit_warnings(root, status);

	return {
		ok: !status.errors.length,
		errors: status.errors,
		warnings: status.warnings ?? [],
	};
}
