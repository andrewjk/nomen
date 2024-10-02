import BaseNode from "./BaseNode";

export default class ImportNode extends BaseNode {
  name: string;

  constructor(start: number, name: string) {
    super("import", start);
    this.name = name;
  }
}
