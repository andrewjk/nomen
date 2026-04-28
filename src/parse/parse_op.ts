import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import parse_type from "./parse_type.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

const OPERATOR_MAP: Record<string, string> = {
	"+": "add",
	"-": "sub",
	"*": "mul",
	"/": "div",
	"%": "mod",
};

export default function parse_op(
	visibility: "inherit" | "pub" | "mod" | "priv",
	status: ParseStatus,
) {
	const start = get_index(status);
	accept(visibility, status);
	accept("op", status);

	const op_symbol = consume(status);
	const func_name = OPERATOR_MAP[op_symbol];

	if (!func_name) {
		// Invalid operator - will be handled by checker later
	}

	const func = new FunctionNode(start, visibility, func_name || op_symbol, new Type(""));

	if (expect("(", status)) {
		const parent = status.stack.at(-1)!;

		if (peek_current(status) !== ")") {
			parse_op_parameter(parent, func, status);
		}

		if (expect(")", status)) {
			if (expect("->", status)) {
				const has_body = parent.node_type === "trait" ? accept("{", status) : expect("{", status);
				if (has_body) {
					func.has_body = true;

					status.stack.push(func);
					parse_statement(status);
					expect("}", status);
					status.stack.pop();

					if (func.return_type.name && !func.has_return) {
						// This shouldn't happen for operators but keep for consistency
					}
				}

				switch (parent.node_type) {
					case "root":
					case "func": {
						(parent as any).statements.push(func);
						break;
					}
					case "struct":
					case "trait": {
						(parent as StructNode).functions.push(func);
						break;
					}
					default: {
						// op cannot appear here
					}
				}
			}
		}
	}
}

function parse_op_parameter(parent: any, func: FunctionNode, status: ParseStatus) {
	const param_start = get_index(status);

	// Check for return type: `out type`
	if (accept("out", status)) {
		func.return_type_start = get_index(status);
		func.return_type = parse_type(status);

		if (accept(",", status)) {
			parse_op_parameter(parent, func, status);
		}
		return;
	}

	const param = new ParameterNode(param_start, "");
	func.params.push(param);

	// Optional parameter declaration
	if (accept("var", status)) {
		param.declaration = "var";
	} else if (accept("cp", status)) {
		param.declaration = "var";
		param.is_copied = true;
	}

	// Try parsing a type, and backtrack if it turns out to be a name with default value
	const saved_i = status.i;
	const saved_errors_length = status.errors.length;
	param.type_start = get_index(status);
	param.type = parse_type(status);

	// If the next token is '=' or ')' or ',', what we parsed was actually the name
	const next = peek_current(status);
	if (next === "=" || next === ")" || next === "," || status.i >= status.tokens.length) {
		status.i = saved_i;
		status.errors.length = saved_errors_length;
		param.type = new Type("");
		param.type_start = undefined;
		param.name = consume(status);
	} else {
		param.name_start = get_index(status);
		param.name = consume(status);
	}

	// Handle `self` parameter
	if (
		param.name === "self" &&
		func.params.length === 1 &&
		(parent.node_type === "struct" || parent.node_type === "trait")
	) {
		param.type_start = param.start;
		param.type = new Type(parent.name);
		param.is_self_param = true;

		if (accept(",", status)) {
			parse_op_parameter(parent, func, status);
		}
		return;
	}

	// Parameter value
	if (accept("=", status)) {
		param.default_value_start = get_index(status);
		param.default_value = parse_expression(status);
	}

	// Check type or value has been set
	if (!param.type.name && !param.default_value) {
		// Error: expected type or default value
	}

	// Next parameter
	if (accept(",", status)) {
		parse_op_parameter(parent, func, status);
	}
}
