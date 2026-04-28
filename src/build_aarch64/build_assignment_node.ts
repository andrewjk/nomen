import AccessFieldNode from "../nodes/AccessFieldNode";
import AccessNode from "../nodes/AccessNode";
import AssignmentNode from "../nodes/AssignmentNode";
import ValueNode from "../nodes/ValueNode";
import type BuildStatus from "../build/BuildStatus";
import type_from_value_node from "../build/utils/type_from_value_node";
import build_node from "./build_node";
import { get_field_offset } from "./utils/struct_layout";

export default function build_assignment_node(
  node: AssignmentNode,
  status: BuildStatus,
) {
  if (node.left_value.node_type === "value") {
    const name = (node.left_value as ValueNode).value;
    const paramReg = status.function_param_regs?.get(name);
    if (paramReg) {
      if (status.function_param_vars?.has(name)) {
        // var param - address in register, store value
        status.code += `mov x2, ${paramReg}\n`;
        build_node(node.right_value, status);
        status.code += `\nstr x0, [x2]\n`;
      } else {
        // const param - can't assign
        build_node(node.right_value, status);
        status.code += `\n// cannot assign to const param\n`;
      }
    } else {
      build_node(node.right_value, status);
      status.code += `\nadr x1, ${name}\nstr x0, [x1]\n`;
    }
  } else if (node.left_value.node_type === "access") {
    const access = node.left_value as AccessNode;
    if (access.access.node_type === "access_field") {
      const field_name = (access.access as AccessFieldNode).name;
      const target_type = type_from_value_node(access.target);
      const offset = get_field_offset(target_type.name, field_name, status);

      // Evaluate RHS
      build_node(node.right_value, status);
      if (!status.code.endsWith("\n")) {
        status.code += "\n";
      }
      status.code += `mov x2, x0\n`;

      // Get base address - for value targets, just use adr; for others, build_node
      if (access.target.node_type === "value") {
        const name = (access.target as ValueNode).value;
        const paramReg = status.function_param_regs?.get(name);
        if (paramReg) {
          if (name === "self" || name === "_self") {
            // self is already the struct address in x0
            // but x0 might have been overwritten by RHS evaluation
            // x2 has the RHS value, so we can use x0 for the address
            if (paramReg !== "x0") {
              status.code += `mov x0, ${paramReg}\n`;
            }
          } else if (status.function_param_vars?.has(name)) {
            // var param contains address
            status.code += `mov x0, ${paramReg}\n`;
          } else {
            // const param contains value, not address - can't assign to field
            status.code += `// cannot assign to field of value param\n`;
            return;
          }
        } else {
          status.code += `adr x0, ${name}\n`;
        }
      } else {
        build_node(access.target, status);
        if (!status.code.endsWith("\n")) {
          status.code += "\n";
        }
      }

      status.code += `str x2, [x0, #${offset}]\n`;
    } else {
      build_node(node.right_value, status);
      status.code += `\n// complex assignment\n`;
    }
  } else {
    build_node(node.right_value, status);
    status.code += `\n// complex assignment\n`;
  }
}
