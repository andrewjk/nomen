import ValueNode from "../nodes/ValueNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";

export default function build_value_node(node: ValueNode, status: BuildStatus) {
	let value = node.value;
	if (value === "null") value = "0";
	else if (value === "true") value = "1";
	else if (value === "false") value = "0";
	else if (value === "default") value = "_echo_default";
	else value = c_function_name(value);
	// `self` is always a pointer in the generated C (matching aarch64):
	// regular methods receive `struct T *self`, and a custom #init uses a
	// local by-value `self` (self_is_local). The former `_self = *self` copy
	// is kept as dead code for compatibility with any code that still
	// references it, but all reads/writes now go through `self->field`.
	// A var/ref param is emitted as a pointer (see build_parameter_node), so
	// each use must dereference it to get the underlying value. Uses where the
	// address is needed (`&x` for forwarding to another ref param, `self` as a
	// pointer for method dispatch) prefix `&` themselves; `&*x` is valid C and
	// simplifies to `x`, so those callers stay correct.
	if (value !== "self" && status.function_ref_params?.has(value) && !status.suppress_dereference) {
		status.code += `*`;
	}
	status.code += value;
}
