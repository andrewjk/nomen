import BaseNode from "./BaseNode";
import Type from "./Type";

export default class AccessFieldNode extends BaseNode {
  name: string;
  type: Type;

  constructor(start: number, name: string, type?: Type) {
    super("access_field", start);
    this.name = name;
    this.type = type || new Type("");
  }
}
