import type ParseNode from "./ParseNode";

export default interface ConstructionNode extends ParseNode {
  node_type: "init";
  name: string;
  params: ParseNode[];
}
