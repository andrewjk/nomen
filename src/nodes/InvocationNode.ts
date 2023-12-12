import BaseNode from "./BaseNode";

export default class InvocationNode extends BaseNode {
  name: string;
  type: string;
  params: BaseNode[];

  constructor(start: number, name: string, type?: string, params?: BaseNode[]) {
    super("invoke", start);
    this.name = name;
    this.type = type || "";
    this.params = params || [];
  }
}
