import type StatementNode from "./StatementNode";
import type SyntaxNode from "./SyntaxNode";
import type ValueNode from "./ValueNode";

export default interface ForNode extends SyntaxNode, StatementNode {
  node_type: "for";
  item?: ValueNode;
  index?: SyntaxNode;
  list?: SyntaxNode;
  statements: SyntaxNode[];
}
