import BaseNode from "./BaseNode";

export default class AccessInvocationNode extends BaseNode {
  name: string;
  params: BaseNode[];
  type: string;
  // HACK: This should probably be on AccessNode
  static: boolean;

  constructor(
    start: number,
    name: string,
    params?: BaseNode[],
    type?: string,
    statico?: boolean,
  ) {
    super("ac_invoke", start);
    this.name = name;
    this.params = params || [];
    this.type = type || "";
    this.static = !!statico;
  }
}
