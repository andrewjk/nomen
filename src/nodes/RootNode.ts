import BaseNode from "./BaseNode";
import type BlockNode from "./BlockNode";
import ImportNode from "./ImportNode";

export default class RootNode extends BaseNode implements BlockNode {
  imports: ImportNode[];
  statements: BaseNode[];

  constructor(imports?: ImportNode[], statements?: BaseNode[]) {
    super("root", 0);
    this.imports = imports || [];
    this.statements = statements || [];
  }
}
