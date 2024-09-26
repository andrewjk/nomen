import BaseNode from "./BaseNode";
import DeclarationNode from "./DeclarationNode";
import FunctionNode from "./FunctionNode";

export default class TraitNode extends BaseNode {
  visibility: "inherit" | "pub" | "mod" | "private";
  name: string;
  fields: DeclarationNode[];
  functions: FunctionNode[];

  constructor(
    start: number,
    visibility: "inherit" | "pub" | "mod" | "private",
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
