import BaseNode from "./BaseNode.ts";
import type { NodeType } from "./NodeType.ts";

/**
 * A node with statements in a body, such as a RootNode or FunctionNode
 */
export default interface BlockNode {
  node_type: NodeType;
  start: number;
  statements: BaseNode[];
}
