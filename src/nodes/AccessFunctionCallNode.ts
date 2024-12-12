import BaseNode from "./BaseNode";
import Type from "./Type";

export default class AccessFunctionCallNode extends BaseNode {
  name: string;
  type: Type;
  params: BaseNode[];

  is_static?: boolean;

  constructor(start: number, name: string, type?: Type, params?: BaseNode[], is_static?: boolean) {
    super("access_func", start);
    this.name = name;
    this.type = type || new Type("");
    this.params = params || [];

    // HACK: For testing
    this.is_static = !!is_static;
  }
}
