import BaseNode from "./BaseNode";
import Type from "./Type";

export default class ArrayValuesNode extends BaseNode {
  values: BaseNode[];
  type: Type;

  constructor(start: number, values?: BaseNode[], type?: Type) {
    super("array", start);
    this.values = values || [];
    this.type = type || new Type("");
  }
}
