import type ParseNode from "./ParseNode";

export default interface ArrayValuesNode extends ParseNode {
  node_type: "array";
  values: ParseNode[];
  type: string;
}
