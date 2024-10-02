import BaseNode from "./BaseNode";
import DeclarationNode from "./DeclarationNode";
import FunctionNode from "./FunctionNode";

export default class StructNode extends BaseNode {
  visibility: "inherit" | "pub" | "mod" | "private";
  name: string;
  traits: string[];
  fields: DeclarationNode[];
  functions: FunctionNode[];
  privates_visible: boolean;
  is_simple_type: boolean;

  constructor(
    start: number,
    visibility: "inherit" | "pub" | "mod" | "private",
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

    this.privates_visible = false;
    this.is_simple_type = ["bool", "int", "string"].includes(this.name);
  }
}
