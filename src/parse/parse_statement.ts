import AccessIndexNode from "../nodes/AccessIndexNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import parse_access from "./parse_access.ts";
import parse_bitset from "./parse_bitset.ts";
import parse_break_or_continue from "./parse_break_or_continue.ts";
import parse_declaration from "./parse_declaration.ts";
import parse_destroy from "./parse_destroy.ts";
import parse_enum from "./parse_enum.ts";
import parse_expression from "./parse_expression.ts";
import parse_for_loop from "./parse_for_loop.ts";
import parse_function from "./parse_function.ts";
import parse_function_call_parameter from "./parse_function_call_parameter.ts";
import parse_if_else from "./parse_if_else.ts";
import parse_import from "./parse_import.ts";
import parse_match from "./parse_match.ts";
import parse_op from "./parse_op.ts";
import parse_panic_or_todo from "./parse_panic_or_todo.ts";
import parse_raw from "./parse_raw.ts";
import parse_return from "./parse_return.ts";
import parse_struct from "./parse_struct.ts";
import parse_switch from "./parse_switch.ts";
import parse_trait from "./parse_trait.ts";
import parse_visibility from "./parse_visibility.ts";
import parse_while_loop from "./parse_while_loop.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_statement(status: ParseStatus) {
	while (true) {
		const value = peek_current(status);
		if (!value) {
			break;
		}

		// Ignore comments
		if (value.startsWith("//") || value.startsWith("/*")) {
			consume(status);
			continue;
		}

		// First check for a keyword (var, if, switch, etc), then check for a
		// following operator (=, +, etc)
		switch (value) {
			case "import": {
				parse_import(status);
				break;
			}
			case "pub":
			case "priv": {
				parse_visibility(value, status);
				break;
			}
			case "const":
			case "var": {
				parse_declaration("mod", value, status);
				break;
			}
			case "struct": {
				parse_struct("mod", status);
				break;
			}
			case "enum": {
				parse_enum("mod", status);
				break;
			}
			case "bitset": {
				parse_bitset("mod", status);
				break;
			}
			case "trait": {
				parse_trait("mod", status);
				break;
			}
			case "func": {
				parse_function("mod", status);
				break;
			}
			case "init": {
				// init = (...) { } is shorthand for func init = (...) { }
				parse_function("mod", status, "init");
				break;
			}
			case "destroy": {
				parse_destroy(status);
				break;
			}
			case "op": {
				parse_op("mod", status);
				break;
			}
			case "if": {
				const if_else = parse_if_else(status);
				add_to_parent(if_else, "If expression", status);
				break;
			}
			case "match": {
				const match_node = parse_match(status);
				add_to_parent(match_node, "Match expression", status);
				break;
			}
			case "switch": {
				const switch_node = parse_switch(status);
				add_to_parent(switch_node, "Switch expression", status);
				break;
			}
			case "else": {
				return;
			}
			case "for": {
				parse_for_loop(status);
				break;
			}
			case "while": {
				parse_while_loop(status);
				break;
			}
			case "break":
			case "continue": {
				parse_break_or_continue(value, status);
				break;
			}
			case "panic":
			case "todo": {
				parse_panic_or_todo(value, status);
				break;
			}
			case "->":
			case "let": {
				accept(value, status);
				const expr = parse_expression(status);
				const ret = new ReturnNode(get_index(status), expr);
				add_to_parent(ret, "Return expression", status);
				break;
			}
			case "=>":
			case "return": {
				parse_return(status);
				break;
			}
			case "raw": {
				parse_raw(status);
				break;
			}
			case "}": {
				return;
			}
			default: {
				parse_statement_start(status);
				break;
			}
		}
	}
}

function parse_statement_start(status: ParseStatus) {
	const start = get_index(status);
	const value = consume(status);
	let node: BaseNode = new ValueNode(start, value);

	while (true) {
		const current_value = peek_current(status);
		switch (current_value) {
			case ".": {
				accept(".", status);
				node = new AccessNode(node.start, node, parse_access(value, status));
				break;
			}
			case "[": {
				accept("[", status);
				const index = parse_expression(status);
				expect("]", status);
				node = new AccessNode(node.start, node, new AccessIndexNode(status.i, index));
				break;
			}
			case "(": {
				accept("(", status);
				const func = new FunctionCallNode(node.start, value);
				if (peek_current(status) !== ")") {
					parse_function_call_parameter(func, status);
				}
				expect(")", status);
				node = func;
				break;
			}
			case "=": {
				accept("=", status);
				node = new AssignmentNode(node.start, node, parse_expression(status));
				break;
			}
			case "+=":
			case "-=":
			case "*=": {
				const op = current_value;
				accept(op, status);
				const rhs = parse_expression(status);
				node = new AssignmentNode(node.start, node, rhs, op);
				break;
			}
			default: {
				add_to_parent(node, node_name(node), status);
				return;
			}
		}
	}
}

function node_name(node: BaseNode) {
	switch (node.node_type) {
		case "declare": {
			return "Declaration";
		}
		case "assign": {
			return "Assignment";
		}
		default: {
			return node.node_type;
		}
	}
}
