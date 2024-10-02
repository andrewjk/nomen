import BaseNode from "./BaseNode";

export default class RawNode extends BaseNode {
  value: string;

  constructor(start: number, value: string) {
    super("raw", start);
    this.value = value;
  }
}
