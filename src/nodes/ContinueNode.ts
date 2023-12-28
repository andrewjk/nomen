import BaseNode from "./BaseNode";

export default class ContinueNode extends BaseNode {
  constructor(start: number) {
    super("continue", start);
  }
}
