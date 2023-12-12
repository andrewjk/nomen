import BaseNode from "./BaseNode";

export default class ArrayValuesNode extends BaseNode {
  values: BaseNode[];
  type: string;

  constructor(start: number, values?: BaseNode[], type?: string) {
    super("array", start);
    this.values = values || [];
    this.type = type || "";
  }
}
