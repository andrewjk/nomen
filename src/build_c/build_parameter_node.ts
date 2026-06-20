import ParameterNode from "../nodes/ParameterNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";

export default function build_parameter_node(node: ParameterNode, status: BuildStatus) {
	const struct_type = status.structs.find((s) => s.name === node.type.name);
	//const is_struct = struct_type && !struct_type.is_simple_type;
	const trait_type = status.traits.find((t) => t.name === node.type.name);
	//const is_trait = !!trait_type;
	const is_struct =
		(node.is_self_param || struct_type || trait_type) && !struct_type?.is_simple_type;
	if (is_struct) {
		status.code += `struct `;
	}
	status.code += c_type(node.type.name);
	if (is_struct || node.declaration === "var" || node.type.is_ref || node.type.is_array) {
		status.code += ` *`;
	} else {
		status.code += ` `;
	}
	status.code += node.name;
}
