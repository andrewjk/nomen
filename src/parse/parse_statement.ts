import add_error from "../add_error.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import LetNode from "../nodes/LetNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import parse_access from "./parse_access.ts";
import parse_async_block from "./parse_async_block.ts";
import parse_bitset from "./parse_bitset.ts";
import parse_break_or_continue from "./parse_break_or_continue.ts";
import parse_declaration from "./parse_declaration.ts";
import parse_destroy from "./parse_destroy.ts";
import parse_enum from "./parse_enum.ts";
import parse_expression from "./parse_expression.ts";
import parse_extend from "./parse_extend.ts";
import parse_for_loop from "./parse_for_loop.ts";
import parse_function from "./parse_function.ts";
import parse_function_call_parameter from "./parse_function_call_parameter.ts";
import parse_if_else from "./parse_if_else.ts";
import parse_import from "./parse_import.ts";
import parse_match from "./parse_match.ts";
import parse_panic_or_todo from "./parse_panic_or_todo.ts";
import parse_raw from "./parse_raw.ts";
import parse_return from "./parse_return.ts";
import parse_spawn from "./parse_spawn.ts";
import parse_struct from "./parse_struct.ts";
import parse_switch from "./parse_switch.ts";
import parse_trait from "./parse_trait.ts";
import parse_visibility from "./parse_visibility.ts";
import parse_while_loop from "./parse_while_loop.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import default_visibility from "./utils/default_visibility.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_statement(status: ParseStatus) {
	while (true) {
		const value = peek_current(status);
		if (!value) {
			break;
		}

		// First check for a keyword (var, if, switch, etc), then check for a
		// following operator (=, +, etc)
		switch (value) {
			case "import": {
				parse_import(status);
				break;
			}
			case "pub":
			case "private": {
				parse_visibility(value, status);
				break;
			}
			case "const":
			case "var":
			case "mov": {
				parse_declaration(default_visibility(status), value, status);
				break;
			}
			case "struct": {
				parse_struct(default_visibility(status), status);
				break;
			}
			case "class": {
				parse_struct(default_visibility(status), status, true);
				break;
			}
			case "extend": {
				parse_extend(default_visibility(status), status);
				break;
			}
			case "enum": {
				parse_enum(default_visibility(status), status);
				break;
			}
			case "bitset": {
				parse_bitset(default_visibility(status), status);
				break;
			}
			case "trait": {
				parse_trait(default_visibility(status), status);
				break;
			}
			case "func": {
				parse_function(default_visibility(status), status);
				break;
			}
			case "inline": {
				consume(status);
				if (peek_current(status) === "func") {
					parse_function(default_visibility(status), status, undefined, true);
				} else {
					add_error(status, "Expected func after inline", get_index(status));
				}
				break;
			}
			case "#": {
				// #init or #destroy — special struct functions
				const next = status.tokens[status.i + 1]?.value;
				if (next === "init") {
					consume(status); // consume #
					consume(status); // consume init
					parse_function(default_visibility(status), status, "#init");
				} else if (next === "destroy") {
					consume(status); // consume #
					consume(status); // consume destroy
					parse_destroy(default_visibility(status), status, "#destroy");
				} else {
					add_error(status, `Expected #init or #destroy`, get_index(status));
					consume(status);
				}
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
				const ret = new LetNode(get_index(status), expr);
				add_to_parent(ret, "Let expression", status);
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
			case "spawn": {
				parse_spawn(status);
				break;
			}
			case "async": {
				parse_async_block(status);
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
			case "(": {
				accept("(", status);
				// Use the parsed ValueNode's value as the call name when it
				// differs from the initial peek (e.g. shorthand `.fixed(50)`).
				const call_name = node.node_type === "value" ? (node as ValueNode).value : value;
				const func = new FunctionCallNode(node.start, call_name);
				if (peek_current(status) !== ")") {
					parse_function_call_parameter(func, status);
				}
				expect(")", status);
				node = func;
				break;
			}
			case "=": {
				accept("=", status);
				const rhs = parse_expression(status);
				const assign = new AssignmentNode(node.start, node, rhs);
				if (peek_current(status) === "swap") {
					consume(status);
					assign.swap = parse_expression(status);
				}
				node = assign;
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
