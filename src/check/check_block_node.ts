import type BlockNode from "../nodes/BlockNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";

export default function check_block_node(node: BlockNode, status: CheckStatus) {
  // Gather structs, traits and funcs that might be used before they are declared
  gather_structs(node, status);

  // Check the block's statements
  status.stack.push(node);
  for (let child of node.statements) {
    check_node(child, status);
  }
  status.stack.pop();
}

function gather_structs(block: BlockNode, status: CheckStatus) {
  for (let node of block.statements) {
    switch (node.node_type) {
      case "struct": {
        const struct = node as StructNode;
        status.types.push(struct.name);
        status.structs.push(struct);
        break;
      }
      case "trait": {
        const trait = node as TraitNode;
        status.types.push(trait.name);
        status.traits.push(trait);
        break;
      }
      case "func": {
        const func = node as FunctionNode;
        status.functions.push(func);
        break;
      }
    }
  }
}
