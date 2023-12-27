import NodeType from "./NodeType";
import Type from "./Type";

/**
 * A node that returns a value via the return statement
 */
export default interface ReturningNode {
  node_type: NodeType;
  start: number;
  return_type: Type;
  has_return?: boolean;
}
