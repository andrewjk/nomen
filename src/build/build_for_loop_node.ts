import ForLoopNode from "../nodes/ForLoopNode";
import RangeNode from "../nodes/RangeNode";
import type BuildStatus from "./BuildStatus";
import build_block_node from "./build_block_node";
import build_node from "./build_node";
import type_from_value_node from "./utils/type_from_value_node";

export default function build_for_loop_node(node: ForLoopNode, status: BuildStatus) {
  if (node.item && node.list) {
    if (node.list.node_type == "range") {
      // HACK: Only want to do this if the item hasn't been declared previously?
      status.code += `int `;
      build_node(node.item, status);
      status.code += ";\nfor (";
      build_node(node.item, status);
      status.code += " = ";
      const range = node.list as RangeNode;
      if (range.left_value) {
        build_node(range.left_value, status);
      }
      status.code += "; ";
      build_node(node.item, status);
      status.code += range.inclusive ? " <= " : " < ";
      if (range.right_value) {
        build_node(range.right_value, status);
      }
      status.code += "; ";
      build_node(node.item, status);
      status.code += "++)\n{\n";
    } else if (!!status.traits.find((t) => t.name === node.item.type.name)) {
      // TODO: Handle index iterator variable
      const length = type_from_value_node(node.list).length;
      status.code += `for (int i = 0; i < `;
      build_node(length!, status);
      status.code += `; i++)\n{\n`;
      status.code += `void *${node.item.value} = *(`;
      build_node(node.list!, status);
      status.code += " + i);\n";
    } else {
      // TODO: Handle index iterator variable
      // HACK: Only want to do this if the item hasn't been declared previously?
      status.code += `int `;
      build_node(node.item, status);
      status.code += ";\nfor (";
      build_node(node.item, status);
      status.code += " = 0; ";
      build_node(node.item, status);
      const length = type_from_value_node(node.list).length;
      status.code += ` < `;
      build_node(length!, status);
      status.code += `; `;
      build_node(node.item, status);
      status.code += "++)\n{\n";
    }
  }

  build_block_node(node, status);

  status.code += `}\n`;
}
