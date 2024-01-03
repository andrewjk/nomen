import BaseNode from "./BaseNode";
import DeclarationNode from "./DeclarationNode";
import FunctionNode from "./FunctionNode";

export default class StructNode extends BaseNode {
  visibility: "def" | "pub" | "sec";
  name: string;
  traits: string[];
  fields: DeclarationNode[];
  functions: FunctionNode[];

  constructor(
    start: number,
    visibility: "def" | "pub" | "sec",
    name: string,
    traits?: string[],
    fields?: DeclarationNode[],
    functions?: FunctionNode[],
  ) {
    super("struct", start);
    this.visibility = visibility;
    this.name = name;
    this.traits = traits || [];
    this.fields = fields || [];
    this.functions = functions || [];
  }
}
