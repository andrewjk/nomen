import add_error from "../../add_error";
import BaseNode from "../../nodes/BaseNode";
import { is_block_node } from "../../nodes/check_node_type";
import type ParseStatus from "../ParseStatus";

export default function add_to_parent(
  node: BaseNode,
  description: string,
  status: ParseStatus,
): boolean {
  const parent = status.stack.at(-1)!;
  if (is_block_node(parent)) {
    parent.statements.push(node);
    return true;
  } else {
    add_error(status, `${description} cannot appear here`, node.start);
    return false;
  }
}
