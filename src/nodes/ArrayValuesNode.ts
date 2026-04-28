import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class ArrayValuesNode extends BaseNode {
  values: BaseNode[];
  type: Type;

  constructor(start: number, values?: BaseNode[], type?: Type) {
    super("array", start);
    this.values = values || [];
    this.type = type || new Type("");
  }
}
