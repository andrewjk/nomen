type NodeType =
  | "root"
  | "struct"
  | "trait"
  | "func"
  | "param"
  | "declare"
  | "assign"
  | "op"
  | "for"
  | "invoke"
  | "access"
  | "ac_field"
  | "ac_invoke"
  | "value"
  | "array"
  | "range"
  | "return";

export default class BaseNode {
  node_type: NodeType;
  start: number;

  constructor(node_type: NodeType, start: number) {
    this.node_type = node_type;
    this.start = start;
  }
}
