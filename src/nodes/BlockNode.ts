import BaseNode from "./BaseNode";
import NodeType from "./NodeType";

/**
 * A node with statements in a body, such as a RootNode or FunctionNode
 */
export default interface BlockNode {
  node_type: NodeType;
  start: number;
  statements: BaseNode[];
}
