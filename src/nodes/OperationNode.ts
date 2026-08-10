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
	| "??"
	| "!"
	| "u-";

export default class OperationNode extends BaseNode {
	op: Operator;
	left_value: BaseNode;
	right_value: BaseNode;
	type: Type;
	operator_func?: {
		struct_name: string;
		func_name: string;
		mangled_name?: string;
		/**
		 * Set when the operator is the logical inverse of the resolved function
		 * — e.g. `!=` dispatched to `eq` (or `==` dispatched to `ne`). The
		 * build backends wrap the call result in a logical NOT.
		 */
		invert?: boolean;
		/**
		 * Set during generic-body checking when `==`/`!=` is applied to
		 * type-parameter-typed operands (e.g. `key == other` inside
		 * `Map<TK, TV>`). The concrete type isn't known until monomorphization,
		 * so the struct/function can't be resolved yet. The build backends
		 * resolve it against the now-concrete operand type — emitting a custom
		 * `eq`/`ne` call if the struct defines one, or falling back to the
		 * builtin comparison for primitives.
		 */
		deferred?: boolean;
	};

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
