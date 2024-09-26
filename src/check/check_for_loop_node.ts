import ForLoopNode from "../nodes/ForLoopNode";
import Type from "../nodes/Type";
import type CheckStatus from "./CheckStatus";
import check_block_node from "./check_block_node";
import check_node from "./check_node";
import type_from_value_node from "./utils/type_from_value_node";

export default function check_for_loop_node(for_loop: ForLoopNode, status: CheckStatus) {
  const old_values = status.values;

  if (for_loop.list) {
    check_node(for_loop.list, status);

    const list_type = type_from_value_node(for_loop.list, status);
    if (!list_type.is_array) {
      status.errors.push({
        message: `For loop list must be an array, not ${list_type.name}`,
        start: for_loop.list.start,
      });
    }

    if (for_loop.item) {
      for_loop.item.type = new Type(list_type.name);

      status.values.push({
        declaration: "var",
        name: for_loop.item.value,
        type: for_loop.item.type,
      });
    }
  }

  check_block_node(for_loop, status);

  status.values = old_values;
}
