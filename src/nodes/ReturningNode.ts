import NodeType from "./NodeType";

/**
 * A node that returns a value via the return statement
 */
export default interface ReturningNode {
  node_type: NodeType;
  start: number;
  return_type: string;
  has_return?: boolean;
}
