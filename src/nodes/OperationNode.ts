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
	| "!!"
	| "!"
	| "p!"
	| "u-";

export default class OperationNode extends BaseNode {
	op: Operator;
	left_value: BaseNode;
	right_value: BaseNode;
	type: Type;
	/**
	 * ERRORS_PLAN (`!!`): the ok-case payload's field name (`value` — the
	 * core Result template's spelling), stamped by the checker so the
	 * backends lower `_data._ok.<field>` without re-resolving the mono.
	 */
	coalesce_ok_field?: string;
	/**
	 * ERRORS_PLAN (postfix `!`): the fail-case payload's field name (`err`),
	 * stamped by the checker for the early-return lowering.
	 */
	propagate_fail_field?: string;
	/**
	 * ERRORS_PLAN (postfix `!`): the declaration being initialized when this
	 * node is evaluated (`var body = load(p)!` → `"body"`), stamped by the
	 * checker. The fail path returns before the binding is assigned, so the
	 * backends skip its (still empty) slot in the fail-path reclaim — and
	 * restore it for the ok path's scope-exit free.
	 */
	in_flight_binding?: string;
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
