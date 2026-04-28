import BaseNode from "./BaseNode.ts";
import type BlockNode from "./BlockNode.ts";
import ImportNode from "./ImportNode.ts";

export default class RootNode extends BaseNode implements BlockNode {
  imports: ImportNode[];
  statements: BaseNode[];

  constructor(imports?: ImportNode[], statements?: BaseNode[]) {
    super("root", 0);
    this.imports = imports || [];
    this.statements = statements || [];
  }
}
