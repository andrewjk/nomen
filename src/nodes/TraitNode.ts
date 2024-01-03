import BaseNode from "./BaseNode";
import DeclarationNode from "./DeclarationNode";
import FunctionNode from "./FunctionNode";

export default class TraitNode extends BaseNode {
  visibility: "def" | "pub" | "sec";
  name: string;
  fields: DeclarationNode[];
  functions: FunctionNode[];

  constructor(
    start: number,
    visibility: "def" | "pub" | "sec",
    name: string,
    fields?: DeclarationNode[],
    functions?: FunctionNode[],
  ) {
    super("trait", start);
    this.visibility = visibility;
    this.name = name;
    this.fields = fields || [];
    this.functions = functions || [];
  }
}
