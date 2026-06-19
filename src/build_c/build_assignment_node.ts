import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_assignment_node(node: AssignmentNode, status: BuildStatus) {
	// Check whether this is an access of a field from a trait rather than a concrete type
	// HACK: This needs to be much more comprehensive, e.g. to handle access
	// chains where something in the middle is a trait
	if (node.left_value.node_type === "access") {
		const accessNode = node.left_value as AccessNode;
		if (accessNode.target.node_type === "value") {
			const traitName = type_from_value_node(accessNode.target as ValueNode).name;
			const trait = status.traits.find((t) => t.name === traitName);
			if (trait) {
				const traitField = trait.fields.find((f) => f.name == accessNode.access.name)!;
				// TODO: Cast to the correct function definition
				// TODO: Use the correct variable name
				// TODO: Pass parameters
				const type = c_type(traitField.type.name);
				const cast = `(void (*)(void *, ${type}))`;
				// TODO: Figure out when to use & here (pass need_pointer into build_node?):
				status.code += `(${cast}_get_trait_func((void *)`;
				build_node(accessNode.target, status);
				const traitIndex = status.traits.indexOf(trait);
				const fieldIndex = trait.functions.length + trait.fields.indexOf(traitField) * 2 + 1;
				status.code += `, ${traitIndex}, ${fieldIndex}))(`;
				build_node(accessNode.target, status);
				status.code += `, `;
				build_node(node.right_value, status);
				status.code += `)`;

				return;
			}
		}
	}

	status.code += ``;
	build_node(node.left_value, status);
	if (node.operator) {
		status.code += ` ${node.operator.slice(0, -1)}= `;
	} else {
		status.code += " = ";
	}
	build_node(node.right_value, status);

	if (node.swap) {
		status.code += `;\n`;
		status.code += `{ `;
		build_node(node.right_value, status);
		status.code += ` = `;
		build_node(node.swap, status);
		status.code += `; }\n`;
	}
}
