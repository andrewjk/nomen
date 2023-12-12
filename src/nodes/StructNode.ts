import BaseNode from "./BaseNode";
import DeclarationNode from "./DeclarationNode";
import FunctionNode from "./FunctionNode";

export default class StructNode extends BaseNode {
  name: string;
  traits: string[];
  fields: DeclarationNode[];
  functions: FunctionNode[];

  constructor(
    start: number,
    name: string,
    traits?: string[],
    fields?: DeclarationNode[],
    functions?: FunctionNode[],
  ) {
    super("struct", start);
    this.name = name;
    this.traits = traits || [];
    this.fields = fields || [];
    this.functions = functions || [];
  }
}
