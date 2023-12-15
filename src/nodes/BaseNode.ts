import NodeType from "./NodeType";

/**
 * The base node type which all nodes extend
 */
export default class BaseNode {
  node_type: NodeType;
  start: number;

  constructor(node_type: NodeType, start: number) {
    this.node_type = node_type;
    this.start = start;
  }
}
