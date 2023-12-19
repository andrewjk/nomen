type NodeType =
  | "root"
  | "struct"
  | "trait"
  | "func"
  | "param"
  | "declare"
  | "assign"
  | "op"
  | "if"
  | "for"
  | "while"
  | "invoke"
  | "access"
  | "ac_field"
  | "ac_invoke"
  | "branch"
  | "value"
  | "array"
  | "range"
  | "return";

export default NodeType;
