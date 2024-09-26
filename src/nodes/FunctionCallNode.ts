import BaseNode from "./BaseNode";
import Type from "./Type";

export default class FunctionCallNode extends BaseNode {
  name: string;
  type: Type;
  params: BaseNode[];

  constructor(start: number, name: string, type?: string | Type, params?: BaseNode[]) {
    super("func_call", start);
    this.name = name;
    this.type = typeof type === "string" ? new Type(type) : type || new Type("");
    this.params = params || [];
  }
}
