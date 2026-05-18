import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

/*
// Technique for syncing array and type from https://stackoverflow.com/a/45486495
// TODO: include range operators ".." and ".=" ??
const OPERATORS = ["+", "-", "*", "/", "%", "==", "!=", ">", ">=", "<", "<=", "&&", "||"] as const;
type OpTuple = typeof OPERATORS;
type Operator = OpTuple[number];
*/

export type Operator =
	| "+"
	| "-"
	| "*"
	| "/"
	| "%"
	| "<<"
	| ">>"
	| "&"
	| "|"
	| "^"
	| "=="
	| "!="
	| ">"
	| ">="
	| "<="
	| "<"
	| "&&"
	| "||"
	| "!";

export default class OperationNode extends BaseNode {
	op: Operator;
	left_value: BaseNode;
	right_value: BaseNode;
	type: Type;
	operator_func?: { struct_name: string; func_name: string };

	constructor(
		start: number,
		op: Operator,
		left_value: BaseNode,
		right_value: BaseNode,
		type?: Type,
	) {
		super("op", start);
		this.op = op;
		this.left_value = left_value;
		this.right_value = right_value;
		this.type = type || new Type("");
	}
}
