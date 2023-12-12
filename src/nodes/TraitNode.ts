import BaseNode from "./BaseNode";
import DeclarationNode from "./DeclarationNode";
import FunctionNode from "./FunctionNode";

export default class TraitNode extends BaseNode {
  name: string;
  fields: DeclarationNode[];
  functions: FunctionNode[];

  constructor(start: number, name: string, fields?: DeclarationNode[], functions?: FunctionNode[]) {
    super("trait", start);
    this.name = name;
    this.fields = fields || [];
    this.functions = functions || [];
  }
}
