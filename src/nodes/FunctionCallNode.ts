import BaseNode from "./BaseNode";
import FunctionNode from "./FunctionNode";
import Type from "./Type";

export default class FunctionCallNode extends BaseNode {
  name: string;
  type: Type;
  params: BaseNode[];

  is_static?: boolean;

  constructor(
    start: number,
    name: string,
    type?: string | Type,
    params?: BaseNode[],
    is_static?: boolean,
  ) {
    super("func_call", start);
    this.name = name;
    this.type = typeof type === "string" ? new Type(type) : type || new Type("");
    this.params = params || [];

    // HACK: For testing
    this.is_static = !!is_static;
  }
}
