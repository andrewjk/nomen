import BaseNode from "./BaseNode";
import Type from "./Type";

export default class ArrayValuesNode extends BaseNode {
  values: BaseNode[];
  type: Type;

  constructor(start: number, values?: BaseNode[], type?: string | Type) {
    super("array", start);
    this.values = values || [];
    this.type = typeof type === "string" ? new Type(type) : type || new Type("");
  }
}
