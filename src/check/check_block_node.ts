import type BlockNode from "../nodes/BlockNode";
import type CheckStatus from "./CheckStatus";
import check_node from "./check_node";

export default function check_block_node(node: BlockNode, status: CheckStatus) {
  status.stack.push(node);
  for (let child of node.statements) {
    check_node(child, status);
  }
  status.stack.pop();
}
