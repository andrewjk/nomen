import BaseNode from "./BaseNode";
import type BlockNode from "./BlockNode";
import ParameterNode from "./ParameterNode";
import type ReturningNode from "./ReturningNode";

export default class FunctionNode extends BaseNode implements BlockNode, ReturningNode {
  name: string;
  return_type: string;
  params: ParameterNode[];
  statements: BaseNode[];
  has_body?: boolean;
  // TODO: Check all branches
  has_return?: boolean;
  return_type_start?: number;

  constructor(
    start: number,
    name: string,
    return_type: string,
    params?: ParameterNode[],
    statements?: BaseNode[],
  ) {
    super("func", start);
    this.name = name;
    this.return_type = return_type;
    this.params = params || [];
    this.statements = statements || [];
    if (statements) {
      this.has_body = true;
      if (statements.find((s) => s.node_type === "return")) {
        this.has_return = true;
      }
    }
  }
}
