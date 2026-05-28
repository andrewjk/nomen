import add_error from "../add_error.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import { is_value_node } from "../nodes/check_node_type.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
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

export default function parse_declaration(
	visibility: "inherit" | "pub" | "mod" | "priv",
	declaration: "const" | "var",
	status: ParseStatus,
) {
	const start = get_index(status);
	accept(visibility, status);
	const decl = new DeclarationNode(start, visibility, declaration, "");
	status.stack.push(decl);

	accept(declaration, status);

	// Check for function type declaration: var func (...) name
	if (peek_current(status) === "func") {
		parse_function_type_declaration(decl, status);
	} else {
		// Try parsing a type, and backtrack if it turns out to be the name
		const saved_i = status.i;
		const saved_errors_length = status.errors.length;
		decl.type_start = get_index(status);
		decl.type = parse_type(status);

		// If the next token is '=' or EOF, what we parsed was actually the name
		if (peek_current(status) === "=" || status.i >= status.tokens.length) {
			status.i = saved_i;
			status.errors.length = saved_errors_length;
			decl.type = new Type("");
			decl.type_start = undefined;
			decl.name_start = get_index(status);
			decl.name = consume(status);
		} else {
			decl.name_start = get_index(status);
			decl.name = consume(status);
		}

		if (accept("=", status)) {
			decl.value = parse_expression(status);
			if (!decl.type.name && is_value_node(decl.value)) {
				decl.type = decl.value.type;
			}
		}
	}

	// Check type or value has been set
	if (!decl.type.name && !decl.value && !decl.func_return_type) {
		add_error(status, `Expected type or default value`, decl.start + decl.declaration.length + 1);
	}

	status.stack.pop();

	// TODO: Move this into add_to_parent somehow
	const parent = status.stack.at(-1)!;
	switch (parent.node_type) {
		case "root":
		case "func":
		case "for":
		case "while":
		case "branch": {
			(parent as BlockNode).statements.push(decl);
			break;
		}
		case "trait":
		case "struct": {
			(parent as StructNode).fields.push(decl);
			break;
		}
		default: {
			add_error(status, "Declaration cannot appear here", decl.start);
		}
	}
}

function parse_function_type_declaration(decl: DeclarationNode, status: ParseStatus) {
	accept("func", status);

	if (expect("(", status)) {
		const params: ParameterNode[] = [];
		let return_type: Type | undefined;

		if (peek_current(status) !== ")") {
			parse_function_type_params(params, status);
			return_type = extract_return_type(params);
		}

		if (expect(")", status)) {
			decl.name_start = get_index(status);
			decl.name = consume(status);
			decl.func_params = params.filter((p) => !p.type.is_return_type);
			decl.func_return_type = return_type;

			// Check for function body with or without `=`
			const has_equals = accept("=", status);
			if (peek_current(status) === "{") {
				// var func (params) name { body } or var func (params) name = { body }
				const func_start = get_index(status);
				const func = new FunctionNode(func_start, "mod", decl.name, new Type(""));
				func.params = decl.func_params || [];
				func.return_type = decl.func_return_type || new Type("");
				accept("{", status);
				func.has_body = true;

				status.stack.push(func);
				parse_statement(status);
				expect("}", status);
				status.stack.pop();

				decl.value = func;
			} else if (has_equals && peek_current(status) === "(") {
				const func = parse_anonymous_function(decl.name, status);
				if (func) {
					decl.value = func;
				}
			} else if (has_equals) {
				decl.value = parse_expression(status);
			}
		}
	}
}

function parse_function_type_params(params: ParameterNode[], status: ParseStatus) {
	const param_start = get_index(status);

	// Check for return type: `out type`
	if (accept("out", status)) {
		const return_type = parse_type(status);
		return_type.is_return_type = true;
		const param = new ParameterNode(param_start, "", return_type);
		param.type.is_return_type = true;
		params.push(param);

		if (accept(",", status)) {
			parse_function_type_params(params, status);
		}
		return;
	}

	const param = new ParameterNode(param_start, "");
	param.type_start = get_index(status);
	param.type = parse_type(status);
	param.name_start = get_index(status);
	param.name = consume(status);
	params.push(param);

	if (accept(",", status)) {
		parse_function_type_params(params, status);
	}
}

function extract_return_type(params: ParameterNode[]): Type | undefined {
	for (const param of params) {
		if (param.type.is_return_type) {
			return param.type;
		}
	}
	return undefined;
}

function parse_anonymous_function(name: string, status: ParseStatus): FunctionNode | undefined {
	const start = get_index(status);
	if (!accept("(", status)) {
		return undefined;
	}

	const func = new FunctionNode(start, "mod", name, new Type(""));

	if (peek_current(status) !== ")") {
		parse_anon_function_parameter(func, status);
	}

	if (expect(")", status)) {
		if (accept("=>", status)) {
			const next = peek_current(status);
			if (next === "(") {
				// Arrow with parentheses: (a, b, out int) => (a + b)
				accept("(", status);
				func.has_body = true;
				func.has_return = true;
				const return_expr = parse_expression(status);
				expect(")", status);
				func.statements.push(new ReturnNode(return_expr.start, return_expr));
			} else if (next === "{") {
				// Arrow with block: (a, b, out int) => { return a + b }
				accept("{", status);
				func.has_body = true;

				status.stack.push(func);
				parse_statement(status);
				expect("}", status);
				status.stack.pop();

				// Arrow with block always has implicit return
				func.has_return = true;
			} else {
				// Direct expression: (a, b, out int) => a + b
				func.has_body = true;
				func.has_return = true;
				const return_expr = parse_expression(status);
				func.statements.push(new ReturnNode(return_expr.start, return_expr));
			}

			return func;
		} else {
			// Block body without arrow: (a, b, out int) { return a + b }
			accept("{", status);
			func.has_body = true;

			status.stack.push(func);
			parse_statement(status);
			expect("}", status);
			status.stack.pop();

			return func;
		}
	}

	return undefined;
}

function parse_anon_function_parameter(func: FunctionNode, status: ParseStatus) {
	const param_start = get_index(status);

	// Check for return type: `out type`
	if (accept("out", status)) {
		func.return_type_start = get_index(status);
		func.return_type = parse_type(status);

		if (accept(",", status)) {
			parse_anon_function_parameter(func, status);
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
	} else if (accept("mov", status)) {
		param.declaration = "var";
		param.is_moved = true;
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

	// Parameter value
	if (accept("=", status)) {
		param.default_value_start = get_index(status);
		param.default_value = parse_expression(status);
	}

	// Check type or value has been set
	if (!param.type.name && !param.default_value) {
		add_error(status, `Expected type or default value`, param.start);
	}

	// Next parameter
	if (accept(",", status)) {
		parse_anon_function_parameter(func, status);
	}
}
