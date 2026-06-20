import AccessIndexNode from "../nodes/AccessIndexNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AnonStructNode from "../nodes/AnonStructNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import CastNode from "../nodes/CastNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import GroupedNode from "../nodes/GroupedNode.ts";
import { is_operation_node } from "../nodes/is_node_type.ts";
import OperationNode, { type Operator } from "../nodes/OperationNode.ts";
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

function restructure_op(
	start: number,
	current_op: Operator,
	current_prec: number,
	current_node: BaseNode,
	expression: OperationNode,
): OperationNode {
	const expression_precedence = operator_precedence(expression.op);
	if (current_prec <= expression_precedence) {
		if (is_operation_node(expression.left_value)) {
			const left_prec = operator_precedence((expression.left_value as OperationNode).op);
			if (current_prec <= left_prec) {
				const restructured_left = restructure_op(
					start,
					current_op,
					current_prec,
					current_node,
					expression.left_value as OperationNode,
				);
				return new OperationNode(start, expression.op, restructured_left, expression.right_value);
			}
		}
		return new OperationNode(
			start,
			expression.op,
			new OperationNode(start, current_op, current_node, expression.left_value),
			expression.right_value,
		);
	}
	return new OperationNode(start, current_op, current_node, expression);
}

function find_matching_close(tokens: { value: string }[], start: number): number {
	let depth = 0;
	for (let i = start; i < tokens.length; i++) {
		if (tokens[i].value === "<") depth++;
		else if (tokens[i].value === ">") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function parse_anon_struct(start: number, status: ParseStatus): AnonStructNode {
	const fields: { name: string; value: BaseNode }[] = [];
	while (peek_current(status) !== "]") {
		const name = consume(status);
		expect("=", status);
		const value = parse_expression(status);
		fields.push({ name, value });
		if (!accept(",", status)) break;
	}
	expect("]", status);
	return new AnonStructNode(start, fields);
}

function parse_primary(status: ParseStatus, value: string): BaseNode {
	const start = get_index(status);
	switch (value) {
		case "!": {
			consume(status);
			const next = peek_current(status) || "??";
			let inner: BaseNode = parse_primary(status, next);
			while (peek_current(status) === ".") {
				accept(".", status);
				inner = new AccessNode(inner.start, inner, parse_access(next, status));
			}
			return new OperationNode(start, "!", inner, inner);
		}
		case ".": {
			consume(status);
			const name = consume(status);
			return new ValueNode(start, `.${name}`);
		}
		case "[": {
			const next = status.tokens[status.i + 1]?.value;
			const after_next = status.tokens[status.i + 2]?.value;
			if (next && after_next === "=") {
				consume(status);
				return parse_anon_struct(start, status);
			}
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
		case "{": {
			const v = consume(status);
			return new ValueNode(start, v);
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
export default function parse_expression(status: ParseStatus, allow_assignment = true): BaseNode {
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
			case ">=": {
				consume(status);
				const expression = parse_expression(status, allow_assignment);
				if (is_operation_node(expression)) {
					node = restructure_op(
						start,
						current_value,
						operator_precedence(current_value),
						node,
						expression,
					);
				} else {
					node = new OperationNode(start, current_value, node, expression);
				}
				break;
			}
			case "<": {
				if (node.node_type === "value") {
					const close_idx = find_matching_close(status.tokens, status.i);
					if (
						close_idx !== -1 &&
						close_idx + 1 < status.tokens.length &&
						status.tokens[close_idx + 1]?.value === "("
					) {
						accept("<", status);
						const type_args = [parse_type(status)];
						while (peek_current(status) === ",") {
							accept(",", status);
							type_args.push(parse_type(status));
						}
						expect(">", status);
						accept("(", status);
						const name = (node as ValueNode).value;
						const func = new FunctionCallNode(start, name);
						func.type_args = type_args;
						if (peek_current(status) !== ")") {
							parse_function_call_parameter(func, status);
						}
						expect(")", status);
						node = func;
						break;
					}
				}

				consume(status);
				const lt_expr = parse_expression(status, allow_assignment);
				if (is_operation_node(lt_expr)) {
					node = restructure_op(start, "<", operator_precedence("<"), node, lt_expr);
				} else {
					node = new OperationNode(start, "<", node, lt_expr);
				}
				break;
			}
			case "<=":
			case "&&":
			case "||":
			case "<<":
			case ">>":
			case "&":
			case "|":
			case "^":
			case "??": {
				consume(status);

				// TODO: Proper order of operations
				// Like https://en.cppreference.com/w/c/language/operator_precedence
				const expression = parse_expression(status, allow_assignment);
				if (is_operation_node(expression)) {
					const current_precedence = operator_precedence(current_value);
					node = restructure_op(start, current_value, current_precedence, node, expression);
				} else {
					node = new OperationNode(start, current_value, node, expression);
				}
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
				const range = new RangeNode(start, node, parse_expression(status));
				node = range;
				break;
			}
			case "=":
			case "+=":
			case "-=":
			case "*=": {
				if (!allow_assignment) return node;
				const op = consume(status);
				const rhs = parse_expression(status);
				const assign = new AssignmentNode(start, node, rhs, op === "=" ? undefined : op);
				if (peek_current(status) === "swap") {
					consume(status);
					assign.swap = parse_expression(status);
				}
				node = assign;
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
		case ">":
		case ">=":
		case "<":
		case "<=": {
			return 6;
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
		case "??": {
			return 13;
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
