import ForLoopNode from "../nodes/ForLoopNode";
import Type from "../nodes/Type";
import type CheckStatus from "./CheckStatus";
import check_block_node from "./check_block_node";
import check_node from "./check_node";
import clone_status from "./utils/clone_status";
import type_from_value_node from "./utils/type_from_value_node";

export default function check_for_loop_node(for_loop: ForLoopNode, status: CheckStatus) {
  let for_status = clone_status(status);

  if (for_loop.list) {
    check_node(for_loop.list, for_status);

    const list_type = type_from_value_node(for_loop.list, for_status);
    if (!list_type.is_array) {
      for_status.errors.push({
        message: `For loop list must be an array, not ${list_type.name}`,
        start: for_loop.list.start,
      });
    }

    if (for_loop.item) {
      for_loop.item.type = new Type(list_type.name);

      for_status.values.push({
        declaration: "var",
        name: for_loop.item.value,
        type: for_loop.item.type,
      });
    }
  }

  check_block_node(for_loop, for_status);
}
