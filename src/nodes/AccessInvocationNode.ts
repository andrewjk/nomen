import BaseNode from "./BaseNode";
import Type from "./Type";

export default class AccessInvocationNode extends BaseNode {
  name: string;
  params: BaseNode[];
  type: Type;
  // HACK: This should probably be on AccessNode
  static: boolean;

  constructor(
    start: number,
    name: string,
    params?: BaseNode[],
    type?: string | Type,
    statico?: boolean,
  ) {
    super("ac_invoke", start);
    this.name = name;
    this.params = params || [];
    this.type = typeof type === "string" ? new Type(type) : type || new Type("");
    this.static = !!statico;
  }
}
