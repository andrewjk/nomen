import AccessIndexNode from "../nodes/AccessIndexNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import CastNode from "../nodes/CastNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import GroupedNode from "../nodes/GroupedNode.ts";
import { is_operation_node } from "../nodes/is_node_type.ts";
import OperationNode from "../nodes/OperationNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import parse_access from "./parse_access.ts";
import parse_array_value from "./parse_array_value.ts";
import parse_function_call_parameter from "./parse_function_call_parameter.ts";
import parse_if_else from "./parse_if_else.ts";
import parse_match from "./parse_match.ts";
import parse_string_interpolation from "./parse_string_interpolation.ts";
import parse_switch from "./parse_switch.ts";
import parse_type from "./parse_type.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

function parse_primary(status: ParseStatus, value: string): BaseNode {
	const start = get_index(status);
	switch (value) {
		case "!": {
			consume(status);
			const next = peek_current(status) || "??";
			const inner = parse_primary(status, next);
			return new OperationNode(start, "!", inner, inner);
		}
		case "[": {
			consume(status);
			const node = new ArrayValuesNode(start);
			if (peek_current(status) !== "]") {
				parse_array_value(node as ArrayValuesNode, status);
			}
			expect("]", status);
			return node;
		}
		case "(": {
			consume(status);
			const node = new GroupedNode(start, parse_expression(status));
			expect(")", status);
			return node;
		}
		case "if": {
			return parse_if_else(status);
		}
		case "match": {
			return parse_match(status);
		}
		case "switch": {
			return parse_switch(status);
		}
		default: {
			if (value && value.startsWith('"') && (value.length === 1 || !value.endsWith('"'))) {
				return parse_string_interpolation(status);
			} else {
				const v = consume(status);
				return new ValueNode(start, v);
			}
		}
	}
}

/**
 * An expression returns a value and can be used e.g. on the right side of an assignment, as the
 * initial value of a declaration or as a parameter value in a function call
 */
export default function parse_expression(status: ParseStatus): BaseNode {
	const start = get_index(status);
	let value = peek_current(status) || "??";
	let node = parse_primary(status, value);

	// Get any accesses or operations applied to the value
	while (true) {
		const current_value = peek_current(status);
		switch (current_value) {
			case ".": {
				accept(".", status);
				const access = new AccessNode(node.start, node, parse_access(value, status));
				node = access;
				break;
			}
			case "[": {
				accept("[", status);
				const index = parse_expression(status);
				expect("]", status);
				const access = new AccessNode(node.start, node, new AccessIndexNode(index.start, index));
				node = access;
				break;
			}
			case "(": {
				accept("(", status);
				const func = new FunctionCallNode(start, value);
				if (peek_current(status) !== ")") {
					parse_function_call_parameter(func, status);
				}
				expect(")", status);
				node = func;
				break;
			}
			case "+":
			case "-":
			case "*":
			case "/":
			case "%":
			case "==":
			case "!=":
			case ">":
			case ">=":
			case "<":
			case "<=":
			case "&&":
			case "||": {
				consume(status);

				// TODO: Proper order of operations
				// Like https://en.cppreference.com/w/c/language/operator_precedence
				const expression = parse_expression(status);
				if (is_operation_node(expression)) {
					const current_precedence = operator_precedence(current_value);
					const expression_precedence = operator_precedence(expression.op);
					if (current_precedence <= expression_precedence) {
						// Move things from the right to the left
						// E.g. from `a + (b > c)` to `(a + b) > c`
						node = new OperationNode(
							start,
							expression.op,
							new OperationNode(start, current_value, node, expression.left_value),
							expression.right_value,
						);
						break;
					}
				}

				node = new OperationNode(start, current_value, node, expression);
				break;
			}
			case "as": {
				consume(status);
				const target_type = parse_type(status);
				node = new CastNode(start, node, target_type);
				break;
			}
			case "..": {
				consume(status);
				const range = new RangeNode(start, node, parse_expression(status), false);
				node = range;
				break;
			}
			case "=":
			case "+=":
			case "-=":
			case "*=": {
				const op = consume(status);
				const rhs = parse_expression(status);
				node = new AssignmentNode(start, node, rhs, op === "=" ? undefined : op);
				break;
			}
			default: {
				return node;
			}
		}
	}
}

function operator_precedence(op: string) {
	switch (op) {
		case "!": {
			return 2;
		}
		case "*":
		case "/":
		case "%": {
			return 3;
		}
		case "+":
		case "-": {
			return 4;
		}
		case "<<":
		case ">>": {
			return 5;
		}
		case "==":
		case "!=": {
			return 7;
		}
		case "&": {
			return 8;
		}
		case "^": {
			return 9;
		}
		case "|": {
			return 10;
		}
		case "&&": {
			return 11;
		}
		case "||": {
			return 12;
		}
		case "=":
		case "+=":
		case "-=":
		case "*=":
		case "/=":
		case "%=":
		case "<<=":
		case ">>=":
		case "&=":
		case "^=":
		case "|=": {
			return 14;
		}
		default: {
			return 100;
		}
	}
}
