import AccessNode from "../nodes/AccessNode";
import AssignmentNode from "../nodes/AssignmentNode";
import ValueNode from "../nodes/ValueNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";
import c_type from "./utils/c_type";
import type_from_value_node from "./utils/type_from_value_node";

export default function build_assignment_node(node: AssignmentNode, status: BuildStatus) {
  // Check whether this is an access of a field from a trait rather than a concrete type
  // HACK: This needs to be much more comprehensive, e.g. to handle access
  // chains where something in the middle is a trait
  if (node.left_value.node_type === "access") {
    const accessNode = node.left_value as AccessNode;
    if (accessNode.source.node_type === "value") {
      const traitName = type_from_value_node(accessNode.source as ValueNode).name;
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
        build_node(accessNode.source, status);
        const traitIndex = status.traits.indexOf(trait);
        const fieldIndex = trait.functions.length + trait.fields.indexOf(traitField) * 2 + 1;
        status.code += `, ${traitIndex}, ${fieldIndex}))(`;
        build_node(accessNode.source, status);
        status.code += `, `;
        build_node(node.right_value, status);
        status.code += `);\n`;

        return;
      }
    }
  }

  status.code += ``;
  build_node(node.left_value, status);
  status.code += " = ";
  build_node(node.right_value, status);
  status.code += ";\n";
}
