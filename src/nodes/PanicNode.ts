import BaseNode from "./BaseNode";

export default class PanicNode extends BaseNode {
  message: string;

  constructor(start: number, message?: string) {
    super("panic", start);
    this.message = message || "";
  }
}
