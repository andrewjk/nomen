import ValueNode from "../nodes/ValueNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";

const INT_LITERAL_SUFFIX: Record<string, string> = {
	int: "L",
	uint: "UL",
	int64: "LL",
	uint64: "ULL",
};

export default function build_value_node(node: ValueNode, status: BuildStatus) {
	let value = node.value;
	if (value === "null") value = "0";
	else if (value === "true") value = "1";
	else if (value === "false") value = "0";
	else if (value === "default") value = "_nomen_default";
	else if (/^[+-]?\d+$/.test(value)) {
		// Nomen integer literals default to `int` (C `long`, 64-bit). Emit the
		// matching C suffix so the literal is the right width: a bare `1` in C
		// is `int` (32-bit), making `1 << 63` undefined behavior.
		value += INT_LITERAL_SUFFIX[node.type?.name ?? "int"] ?? "";
	} else value = c_function_name(value);
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
	// A `ref` class param is a double pointer (`struct T **`); a value-use
	// reads the underlying instance pointer, so dereference once. Callers that
	// need the address (`&h` write-back, forwarding) set suppress_dereference.
	if (value !== "self" && status.ref_class_params?.has(value) && !status.suppress_dereference) {
		status.code += `(*${value})`;
		return;
	}
	status.code += value;
}
