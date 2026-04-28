import BaseNode from "./BaseNode.ts";

export default class ContinueNode extends BaseNode {
  constructor(start: number) {
    super("continue", start);
  }
}
