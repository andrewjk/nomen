import ParseNode from "./ParseNode";

export default interface AssignmentNode extends ParseNode {
  node_type: "ass";
  left_value: string;
  right_value: string;
}
