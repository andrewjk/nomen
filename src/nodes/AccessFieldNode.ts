import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class AccessFieldNode extends BaseNode {
  name: string;
  type: Type;

  constructor(start: number, name: string, type?: Type) {
    super("access_field", start);
    this.name = name;
    this.type = type || new Type("");
  }
}
