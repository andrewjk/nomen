import BaseNode from "./BaseNode.ts";

export default class ImportNode extends BaseNode {
  name: string;

  constructor(start: number, name: string) {
    super("import", start);
    this.name = name;
  }
}
