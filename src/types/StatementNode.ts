import SyntaxNode from "./SyntaxNode";

export default interface StatementNode extends SyntaxNode {
  statements: SyntaxNode[];
}
