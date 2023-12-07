export default interface SyntaxNode {
  node_type:
    | "root"
    | "struct"
    | "trait"
    | "func"
    | "param"
    | "decl"
    | "assign"
    | "op"
    | "for"
    | "invoke"
    | "access"
    | "accfld"
    | "accinv"
    | "value"
    | "array"
    | "range"
    | "ret";
  start: number;
}
