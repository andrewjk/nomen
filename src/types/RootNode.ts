import type StatementNode from "./StatementNode";
import type SyntaxNode from "./SyntaxNode";

export default interface RootNode extends SyntaxNode, StatementNode {
  node_type: "root";
  statements: SyntaxNode[];
}
