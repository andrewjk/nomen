import BaseNode from "./BaseNode";

/*
// Technique for syncing array and type from https://stackoverflow.com/a/45486495
// TODO: include range operators ".." and ".=" ??
const OPERATORS = ["+", "-", "*", "/", "%", "==", "!=", ">", ">=", "<", "<=", "&&", "||"] as const;
type OpTuple = typeof OPERATORS;
type Operator = OpTuple[number];
*/

type Operator = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | ">" | ">=" | "<" | "<=" | "&&" | "||";
// TODO: inclued range operators ".." and ".=" ??

export default class OperationNode extends BaseNode {
  op: Operator;
  left_value: BaseNode;
  right_value: BaseNode;
  type: string;

  constructor(
    start: number,
    op: Operator,
    left_value: BaseNode,
    right_value: BaseNode,
    type?: string,
  ) {
    super("op", start);
    this.op = op;
    this.left_value = left_value;
    this.right_value = right_value;
    this.type = type || "";
  }
}
