import emission_label from "../../build_common/emission_label.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import build_function_node from "../build_function_node.ts";
import type BuildStatus from "../BuildStatus.ts";
import c_function_name from "./c_function_name.ts";

/**
 * Emit a lambda (anonymous FunctionNode) in VALUE position. C may not nest a
 * function definition inside an expression, so the definition is built into a
 * buffer that build_root_node flushes at file scope (the headers carry the
 * prototype, so definition order among file-scope functions is irrelevant);
 * the value left in the expression is the function's identifier.
 *
 * The lambda is semantically a top-level function: the C scope-frame stack
 * (and its loop/class-var frames) is isolated so the lambda's return-path
 * reclamation only sees the lambda's own declarations — the enclosing
 * function's live `_param_N` temps must not be freed (twice) from inside it.
 *
 * `emit_name` is false for the func-typed declaration path
 * (build_function_type_declaration), whose "declaration" is only the
 * definition itself — no local is emitted, and uses of the name resolve to
 * the function.
 */
export default function build_lambda_value(
	node: FunctionNode,
	status: BuildStatus,
	emit_name = true,
): void {
	const saved_code = status.code;
	const saved_headers = status.headers;
	const saved_scope_stack = status.c_scope_stack;
	const saved_loop_frames = status.c_loop_frame_depth;
	const saved_class_frames = status.class_vars_frames;
	status.code = "";
	status.headers = "";
	status.c_scope_stack = [];
	status.c_loop_frame_depth = undefined;
	status.class_vars_frames = undefined;
	build_function_node(node, status);
	status.lambda_definitions = (status.lambda_definitions ?? "") + status.code;
	status.code = saved_code;
	status.headers = saved_headers + status.headers;
	status.c_scope_stack = saved_scope_stack;
	status.c_loop_frame_depth = saved_loop_frames;
	status.class_vars_frames = saved_class_frames;
	if (emit_name) {
		status.code += c_function_name(emission_label(node));
	}
}
