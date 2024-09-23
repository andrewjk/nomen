import BaseNode from "../../nodes/BaseNode";
import isBlockNode from "../../nodes/isBlockNode";
import type ParseStatus from "../ParseStatus";

export default function add_to_parent(
  node: BaseNode,
  description: string,
  status: ParseStatus,
): boolean {
  const parent = status.stack.at(-1)!;
  if (isBlockNode(parent)) {
    parent.statements.push(node);
    return true;
  } else {
    status.errors.push({
      message: `${description} cannot appear here`,
      start: node.start,
    });
    return false;
  }
}
