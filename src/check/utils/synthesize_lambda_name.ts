import FunctionNode from "../../nodes/FunctionNode.ts";
import type CheckStatus from "../CheckStatus.ts";

/**
 * A lambda (anonymous FunctionNode) used as a VALUE — a func-typed call
 * argument, or an assignment RHS whose target is a struct field — has no
 * source name to emit under. Both backends lower a lambda value to a
 * file-scope function (aarch64 passes its address, C its identifier), so it
 * needs a program-unique name: synthesized from the shared var-name counter
 * and uniquified against every function emission name (the same registry
 * assign_function_label uniquifies nested-function labels against).
 */
export default function synthesize_lambda_name(func: FunctionNode, status: CheckStatus): string {
	let name = `_lambda_${status.var_name_counter.value++}`;
	while (status.function_emission_names?.has(name)) {
		name = `_lambda_${status.var_name_counter.value++}`;
	}
	func.name = name;
	func.label_name = name;
	// Value-position lambdas are closure targets: their definitions carry
	// the hidden env parameter and they are invoked through descriptors
	// (CLOSURE.md). Declaration-named lambdas (parse_declaration
	// names them after the variable) are called directly and never stamped.
	(func as unknown as { is_closure?: boolean }).is_closure = true;
	return name;
}
