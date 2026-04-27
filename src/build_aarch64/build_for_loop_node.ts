import ForLoopNode from "../nodes/ForLoopNode";
import RangeNode from "../nodes/RangeNode";
import type BuildStatus from "../build/BuildStatus";
import type_from_value_node from "../build/utils/type_from_value_node";
import build_block_node from "./build_block_node";
import build_node from "./build_node";

let label_counter = 0;

export function reset_label_counter() {
  label_counter = 0;
}

export default function build_for_loop_node(
  node: ForLoopNode,
  status: BuildStatus,
) {
  const old_scoped_declarations = status.scoped_declarations;
  status.scoped_declarations = [];

  const label = label_counter++;
  const item_name = node.item.value;

  if (node.list && node.list.node_type === "range") {
    const range = node.list as RangeNode;

    // init: item = left_value
    if (range.left_value) {
      build_node(range.left_value, status);
    } else {
      status.code += `ldr x0, =0`;
    }
    status.code += `\nadr x1, ${item_name}\nstr x0, [x1]\n`;

    // loop start
    status.code += `.for_${label}:\n`;

    // condition: item < right_value
    build_node(node.item, status);
    status.code += `\nmov x2, x0\n`;
    if (range.right_value) {
      build_node(range.right_value, status);
    } else {
      status.code += `ldr x0, =0`;
    }
    status.code += `\ncmp x2, x0\n`;
    if (range.inclusive) {
      status.code += `bgt .end_${label}\n`;
    } else {
      status.code += `bge .end_${label}\n`;
    }

    // body
    build_block_node(node, status);

    // increment
    build_node(node.item, status);
    status.code += `\nadd x0, x0, #1\n`;
    status.code += `adr x1, ${item_name}\nstr x0, [x1]\n`;

    status.code += `b .for_${label}\n`;
    status.code += `.end_${label}:\n`;
  } else {
    // array iteration
    const type = type_from_value_node(node.list);
    const length = type.length ? (type.length as any).value : "0";

    // init: item = 0
    status.code += `ldr x0, =0\n`;
    status.code += `adr x1, ${item_name}\nstr x0, [x1]\n`;

    // loop start
    status.code += `.for_${label}:\n`;

    // condition: item < length
    build_node(node.item, status);
    status.code += `\nmov x2, x0\n`;
    status.code += `ldr x0, =${length}\n`;
    status.code += `cmp x2, x0\n`;
    status.code += `bge .end_${label}\n`;

    // body
    build_block_node(node, status);

    // increment
    build_node(node.item, status);
    status.code += `\nadd x0, x0, #1\n`;
    status.code += `adr x1, ${item_name}\nstr x0, [x1]\n`;

    status.code += `b .for_${label}\n`;
    status.code += `.end_${label}:\n`;
  }

  status.scoped_declarations = old_scoped_declarations;
}
