import add_error from "../add_error.ts";
import BaseNode from "../nodes/BaseNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
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
import expect_close_angle from "./utils/expect_close_angle.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";
import peek_next from "./utils/peek_next.ts";

export default function parse_function(
	visibility: "pub" | "private",
	status: ParseStatus,
	name_override?: string,
	is_inline?: boolean,
) {
	const start = get_index(status);
	if (name_override) {
		accept(name_override, status);
	} else {
		accept(visibility, status);
		accept("func", status);
	}
	let name = name_override || consume(status);
	if (!name_override && name === "#") {
		const next = consume(status);
		if (next === "init" || next === "destroy" || next.startsWith("op_")) {
			name = `#${next}`;
		}
	}
	// Map #op_* to internal function names
	const op_internal: Record<string, string> = {
		"#op_add": "add",
		"#op_sub": "sub",
		"#op_mul": "mul",
		"#op_div": "div",
		"#op_mod": "mod",
		"#op_as": "as",
		"#op_eq": "eq",
		"#op_ne": "ne",
	};
	if (op_internal[name]) {
		name = op_internal[name];
	}
	const parent_for_type = status.stack.at(-1);
	let return_type = new Type("");
	if (
		name === "#init" &&
		(parent_for_type?.node_type === "struct" || parent_for_type?.node_type === "extend")
	) {
		return_type = new Type((parent_for_type as StructNode).name);
	}
	const func = new FunctionNode(start, visibility, name, return_type);
	if (is_inline) func.is_inline = true;

	if (accept("<", status)) {
		func.type_params.push(consume(status));
		while (accept(",", status)) {
			func.type_params.push(consume(status));
		}
		expect_close_angle(status);
	}

	if (expect("=", status) && expect("(", status)) {
		const parent = status.stack.at(-1)!;

		if (peek_current(status) !== ")") {
			parse_function_parameter(parent, func, status);
		}

		// `#destroy` may be written with no parameter list (`func #destroy = ()`)
		// or with an explicit `self`/`ref self`. Only auto-inject a mutable self
		// when the author didn't supply one — otherwise a duplicate "self"
		// parameter is created and the author's (mutable) declaration is lost.
		if (
			name === "#destroy" &&
			parent.node_type === "struct" &&
			!func.params.some((p) => p.is_self_param)
		) {
			const self_param = new ParameterNode(start, "self", new Type((parent as StructNode).name));
			self_param.is_self_param = true;
			self_param.declaration = "var";
			func.params.unshift(self_param);
		}

		// Validate: variadic params must be last
		for (let i = 0; i < func.params.length; i++) {
			if (func.params[i].is_variadic && i < func.params.length - 1) {
				add_error(status, `Variadic parameter must be the last parameter`, func.params[i].start);
			}
		}

		func.is_static = !func.params[0]?.is_self_param;

		if (expect(")", status)) {
			if (accept("=>", status)) {
				func.has_body = true;
				func.has_return = true;
				func.is_arrow_body = true;
				const return_expr = parse_expression(status);
				func.statements.push(new ReturnNode(return_expr.start, return_expr));
			} else {
				const has_body = parent.node_type === "trait" ? accept("{", status) : expect("{", status);
				if (has_body) {
					func.has_body = true;

					status.stack.push(func);
					parse_statement(status);
					expect("}", status);
					status.stack.pop();

					if (
						func.return_type.name &&
						!func.has_return &&
						name !== "#init" &&
						name !== "#destroy"
					) {
						const is_raw_only =
							func.statements.length > 0 && func.statements.every((s) => s.node_type === "raw");
						if (!is_raw_only) {
							add_error(status, `Missing return`, status.tokens[status.i - 2].i);
						}
					}
				}
			}

			switch (parent.node_type) {
				case "root":
				case "func": {
					(parent as BlockNode).statements.push(func);
					break;
				}
				case "struct":
				case "trait":
				case "extend": {
					(parent as StructNode).functions.push(func);
					break;
				}
				default: {
					add_error(status, "Function cannot appear here", func.start);
				}
			}
		}
	}
}

function parse_function_parameter(parent: BaseNode, func: FunctionNode, status: ParseStatus) {
	const param_start = get_index(status);

	// `mov out TYPE` — an ownership-transferring (owned) return. Distinguished
	// from a `mov TYPE name` parameter by the `out` that follows `mov`.
	const returns_mov = peek_current(status) === "mov" && peek_next(status) === "out";
	if (returns_mov) {
		accept("mov", status);
	}

	if (accept("out", status)) {
		func.return_type_start = get_index(status);
		func.return_type = parse_type(status);
		func.returns_mov = returns_mov;

		// Optional return contract: `out TYPE: out >= 0 && out < cap`
		// The placeholder `out` refers to the return value.
		if (accept(":", status)) {
			func.return_constraint = parse_expression(status);
		}

		if (accept(",", status)) {
			parse_function_parameter(parent, func, status);
		}
		return;
	}

	const param = new ParameterNode(param_start, "");
	func.params.push(param);

	if (accept("var", status)) {
		param.declaration = "var";
	} else if (accept("cp", status)) {
		param.declaration = "var";
		param.is_copied = true;
	} else if (accept("mov", status)) {
		param.declaration = "var";
		param.is_moved = true;
	}

	if (status.tokens[status.i]?.value === "ref" && status.tokens[status.i + 1]?.value === "self") {
		param.declaration = "var";
		param.is_ref = true;
		status.i += 2;
		param.name = "self";

		// ref self with constraint: ref self: constraint
		if (accept(":", status)) {
			param.constraint = parse_expression(status);
		}

		param.type_start = param.start;
		param.type = new Type((parent as StructNode).name);
		param.is_self_param = true;
		if (func.name === "#init") {
			param.declaration = "var";
		}

		if (accept(",", status)) {
			parse_function_parameter(parent, func, status);
		}

		return;
	} else if (
		status.tokens[status.i]?.value === "self" &&
		(parent.node_type === "struct" || parent.node_type === "trait" || parent.node_type === "extend")
	) {
		// `var self` / `cp self` / `mov self` are rejected: use `ref self`
		// for mutation (visible to the caller) or bare `self` (read-only; in
		// `#init` it may assign fields). A declaration keyword consumed above
		// (var/cp/mov all set declaration="var") is detectable here because a
		// bare `self` is still "const" at this point — the `#init` override
		// below hasn't run yet, so this can't be done later in the check pass.
		if (param.declaration === "var") {
			add_error(
				status,
				`'var self' is not allowed — use 'ref self' to mutate, or bare 'self' for read-only access`,
				param.start,
			);
		}
		// self with optional constraint: self: constraint
		status.i += 1;
		param.name = "self";

		if (accept(":", status)) {
			param.constraint = parse_expression(status);
		}

		param.type_start = param.start;
		param.type = new Type((parent as StructNode).name);
		param.is_self_param = true;
		if (func.name === "#init") {
			param.declaration = "var";
		}

		if (accept(",", status)) {
			parse_function_parameter(parent, func, status);
		}

		return;
	} else {
		if (accept("...", status)) {
			param.is_variadic = true;
		}

		const saved_i = status.i;
		const saved_errors_length = status.errors.length;
		param.type_start = get_index(status);
		param.type = parse_type(status);

		if (param.type.name === "func" && accept("(", status)) {
			const func_type_params: ParameterNode[] = [];

			if (peek_current(status) !== ")") {
				parse_param_func_type_params(func_type_params, status);
			}

			if (expect(")", status)) {
				for (const fp of func_type_params) {
					if (fp.type.is_return_type) {
						param.func_return_type = fp.type;
					} else {
						if (!param.func_params) param.func_params = [];
						param.func_params.push(fp);
					}
				}
			}

			param.name_start = get_index(status);
			param.name = consume(status);
		} else {
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
		}
	}

	// Parse parameter constraint: int x: x > 5
	if (accept(":", status)) {
		param.constraint = parse_expression(status);
	}

	if (accept("=", status)) {
		param.default_value_start = get_index(status);
		param.default_value = parse_expression(status);
	}

	if (!param.type.name && !param.default_value) {
		add_error(status, `Expected type or default value`, param.start);
	}

	if (accept(",", status)) {
		parse_function_parameter(parent, func, status);
	}
}

function parse_param_func_type_params(params: ParameterNode[], status: ParseStatus) {
	const param_start = get_index(status);

	if (accept("out", status)) {
		const return_type = parse_type(status);
		return_type.is_return_type = true;
		const param = new ParameterNode(param_start, "", return_type);
		param.type.is_return_type = true;
		params.push(param);

		if (accept(",", status)) {
			parse_param_func_type_params(params, status);
		}
		return;
	}

	const param = new ParameterNode(param_start, "");
	param.type_start = get_index(status);
	param.type = parse_type(status);
	params.push(param);

	if (accept(",", status)) {
		parse_param_func_type_params(params, status);
	}
}
