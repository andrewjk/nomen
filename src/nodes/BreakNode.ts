import BaseNode from "./BaseNode";

export default class BreakNode extends BaseNode {
  constructor(start: number) {
    super("break", start);
  }
}
