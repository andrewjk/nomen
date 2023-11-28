import type ParseNode from "./ParseNode";

export default interface AssignmentNode extends ParseNode {
  node_type: "assign";
  left_value?: ParseNode;
  right_value?: ParseNode;
}
