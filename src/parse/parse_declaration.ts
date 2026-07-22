import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import { is_value_node } from "../nodes/check_node_type.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import parse_type from "./parse_type.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import default_visibility from "./utils/default_visibility.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_declaration(
	visibility: "pub" | "private",
	declaration: "const" | "var" | "mov",
	status: ParseStatus,
) {
	const start = get_index(status);
	accept(visibility, status);

	// Detect destructuring: `var [a, b, ...] = expr`
	// Look ahead: if the bracketed names are followed by `=`, treat as destructuring.
	if (
		peek_current(status) === declaration &&
		status.tokens[status.i + 1]?.value === "[" &&
		looks_like_destructuring(status, status.i + 1)
	) {
		accept(declaration, status);
		parse_destructuring(visibility, declaration, start, status);
		return;
	}

	const decl = new DeclarationNode(start, visibility, declaration, "");
	status.stack.push(decl);

	accept(declaration, status);
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

		// Parse field/variable constraint: var int x: x > 5
		if (accept(":", status)) {
			decl.constraint = parse_expression(status, false);
		}

		if (accept("=", status)) {
			decl.value = parse_expression(status);
			if (!decl.type.name && is_value_node(decl.value)) {
				decl.type = decl.value.type;
			}
			// `var X b = mov obj.field swap <replacement>`: moving a field out
			// invalidates it, so a swap replacement is required to revalidate the
			// field (mirrors assignment/param swap).
			if (peek_current(status) === "swap") {
				accept("swap", status);
				decl.swap = parse_expression(status);
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
		case "branch":
		case "async_block": {
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
				const func = new FunctionNode(
					func_start,
					default_visibility(status),
					decl.name,
					new Type(""),
				);
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

		if (accept(",", status) && peek_current(status) !== ")") {
			parse_function_type_params(params, status);
		}
		return;
	}

	const param = new ParameterNode(param_start, "");
	param.type_start = get_index(status);
	param.type = parse_type(status);

	// In a function-type signature the parameters are bare types, so a token
	// following a type is only treated as the parameter name when it is not
	// the end of the parameter list or the start of the return type.
	const next = peek_current(status);
	if (next !== ")" && next !== "," && next !== "out" && status.i < status.tokens.length) {
		param.name_start = get_index(status);
		param.name = consume(status);
	}
	params.push(param);

	if (accept(",", status) && peek_current(status) !== ")") {
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

export function parse_anonymous_function(
	name: string,
	status: ParseStatus,
): FunctionNode | undefined {
	const start = get_index(status);
	if (!accept("(", status)) {
		return undefined;
	}

	const func = new FunctionNode(start, default_visibility(status), name, new Type(""));

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

	// Check type or value has been set. In an anonymous function the parameters
	// are bare names whose types are inferred from the assigned function type,
	// so an untyped parameter with a name is allowed here.
	if (!param.type.name && !param.default_value && !param.name) {
		add_error(status, `Expected type or default value`, param.start);
	}

	// Next parameter
	if (accept(",", status)) {
		parse_anon_function_parameter(func, status);
	}
}

/**
 * Look ahead from a `[` at position `start_idx` to see if this is
 * destructuring (names then `=`) vs. a tuple type declaration
 * (types then a name).
 */
function looks_like_destructuring(status: ParseStatus, start_idx: number): boolean {
	let depth = 0;
	let j = start_idx;
	while (j < status.tokens.length) {
		const v = status.tokens[j].value;
		if (v === "[") depth++;
		else if (v === "]") {
			depth--;
			if (depth === 0) {
				// Check what's after the matching ]
				const after = status.tokens[j + 1]?.value;
				return after === "=";
			}
		}
		j++;
	}
	return false;
}

/**
 * Parse `var [a, b, ...] = expr` — produces a temp declaration holding the
 * RHS value, plus one declaration per destructured binding. Each binding's
 * value is an `AccessFieldNode` marked `is_destructure`; the check pass
 * resolves it to a tuple field (`_i`), an array element (`.at(i)`), or a
 * struct/class field (`.name`) based on the right-hand side's type.
 *
 * Two binding forms are accepted:
 *   - bare name: `a` — positional (tuples/arrays) or same-named field (structs)
 *   - rename:    `field = name` — struct/class field accessed as `field`,
 *     bound to `name`
 */
function parse_destructuring(
	visibility: "pub" | "private",
	declaration: "const" | "var" | "mov",
	start: number,
	status: ParseStatus,
) {
	expect("[", status);
	const bindings: { name: string; field: string; rename: boolean }[] = [];
	let index = 0;
	while (peek_current(status) !== "]" && status.i < status.tokens.length) {
		const first = consume(status);
		let field = first;
		let name = first;
		let rename = false;
		// `[field = name]` rename form (struct/class destructuring only)
		if (peek_current(status) === "=") {
			accept("=", status);
			name = consume(status);
			field = first;
			rename = true;
		}
		bindings.push({ name, field, rename });
		index++;
		if (!accept(",", status)) break;
	}
	expect("]", status);
	expect("=", status);
	const value = parse_expression(status);

	const parent = status.stack.at(-1)!;
	const push_to_parent = (node: DeclarationNode) => {
		switch (parent.node_type) {
			case "root":
			case "func":
			case "for":
			case "while":
			case "branch":
			case "async_block": {
				(parent as BlockNode).statements.push(node);
				break;
			}
			default: {
				add_error(status, "Destructuring cannot appear here", start);
			}
		}
	};

	// If the RHS is a simple value, access fields directly off it without
	// introducing a temporary. Otherwise create a temp.
	const value_is_simple = value.node_type === "value";
	let base_node: BaseNode;
	if (value_is_simple) {
		base_node = value;
	} else {
		const temp_counter = (status as any).__tuple_destructure_counter || 0;
		(status as any).__tuple_destructure_counter = temp_counter + 1;
		const temp_name = `_tuple_dst_${temp_counter}`;
		const temp_decl = new DeclarationNode(
			start,
			"private",
			"const",
			temp_name,
			new Type(""),
			value,
		);
		push_to_parent(temp_decl);
		base_node = new ValueNode(start, temp_name);
	}

	for (let i = 0; i < bindings.length; i++) {
		const binding = bindings[i];
		const access_field = new AccessFieldNode(start, binding.field);
		// Marker resolved by check_access_node from the RHS type:
		//   tuple  -> `._i`      (field rewrite)
		//   array  -> `.at(i)`   (rewrite to access_func)
		//   struct -> `.field`   (as-is)
		access_field.is_destructure = true;
		access_field.destructure_index = i;
		access_field.is_destructure_rename = binding.rename;
		const access = new AccessNode(start, base_node, access_field);
		const name_decl = new DeclarationNode(
			start,
			visibility,
			declaration,
			binding.name,
			new Type(""),
			access,
		);
		push_to_parent(name_decl);
	}
}
