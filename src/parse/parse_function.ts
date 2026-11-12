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
import check_missing_return from "./utils/check_missing_return.ts";
import consume from "./utils/consume.ts";
import consume_name from "./utils/consume_name.ts";
import expect from "./utils/expect.ts";
import expect_close_angle from "./utils/expect_close_angle.ts";
import get_index from "./utils/get_index.ts";
import {
	adopt_func_param_type,
	at_func_type,
	parse_func_type,
	parse_func_type_signature,
	reject_void_type,
} from "./utils/parse_func_type.ts";
import peek_current from "./utils/peek_current.ts";
import peek_next from "./utils/peek_next.ts";

export default function parse_function(
	visibility: "pub" | "private" | "internal",
	status: ParseStatus,
	name_override?: string,
	is_inline?: boolean,
	is_foreign?: boolean,
	is_unsafe?: boolean,
) {
	const start = get_index(status);
	if (name_override) {
		accept(name_override, status);
	} else {
		accept(visibility, status);
		accept("func", status);
	}
	// Function/method names are allowed to be keywords: the name after `func`
	// is unambiguous, and calls always go through `.name(...)` access (e.g.
	// `Regex.match(...)`), which parses in its own unambiguous position.
	let name = name_override || consume(status);
	if (!name_override && name === "#") {
		const next = consume(status);
		if (
			next === "init" ||
			next === "destroy" ||
			next === "spawn" ||
			next === "weak" ||
			next === "handle" ||
			next.startsWith("op_")
		) {
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
		(name === "#init" || name === "#spawn") &&
		(parent_for_type?.node_type === "struct" || parent_for_type?.node_type === "extend")
	) {
		return_type = new Type((parent_for_type as StructNode).name);
	}
	const func = new FunctionNode(start, visibility, name, return_type);
	if (is_inline) func.is_inline = true;
	if (is_unsafe) {
		func.is_unsafe = true;
		// Lockdown: `unsafe` is reserved for the System library. The boundary
		// is the end of the user's own source; source offsets past it belong
		// to the appended library source.
		if (status.unsafe_boundary === undefined || start < status.unsafe_boundary) {
			add_error(
				status,
				`'unsafe' is reserved for the System library — raw pointer manipulation is not available to user code`,
				start,
			);
		}
	}
	if (is_foreign) {
		func.is_foreign = true;
		// Free externs emit under a prefixed label so the marshalling adapter
		// can never collide with the C symbol it wraps (e.g. `atoi`). Method
		// externs keep the `struct_method` label, which can't collide either.
		const foreign_parent = status.stack.at(-1);
		if (foreign_parent?.node_type === "root" || foreign_parent?.node_type === "func") {
			func.label_name = `foreign_${name}`;
		}
	}

	if (accept("<", status)) {
		func.type_params.push(consume_name(status));
		while (accept(",", status)) {
			func.type_params.push(consume_name(status));
		}
		expect_close_angle(status);
	}

	if (expect("=", status) && expect("(", status)) {
		const parent = status.stack.at(-1)!;

		if (peek_current(status) !== ")") {
			parse_function_parameter(parent, func, status);
		}

		// `#destroy` and `#spawn` may be written with no parameter list
		// (`func #destroy = ()`) or with an explicit `self`/`ref self`. Only
		// auto-inject a mutable self when the author didn't supply one —
		// otherwise a duplicate "self" parameter is created and the author's
		// (mutable) declaration is lost. (`#spawn` is the Spawnable
		// construction marker — ASYNC.md; its body is a
		// declaration, the compiler generates the construction.)
		if (
			(name === "#destroy" || name === "#spawn") &&
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
			if (is_foreign) {
				// `foreign func` — declaration only, no body. The backends emit
				// a marshalling adapter that calls the C symbol.
				func.is_foreign = true;
			} else if (accept("=>", status)) {
				if (peek_current(status) === "{") {
					// `=>` introduces an implicit-return expression only; a
					// block body must drop the arrow (`func f = (…) { … }`).
					add_error(
						status,
						`'=>' must be followed by an expression; remove '=>' for a block body`,
						get_index(status),
					);
					// Recover by parsing the block as the body so the token
					// stream stays in sync for later errors.
					accept("{", status);
					func.has_body = true;
					status.stack.push(func);
					parse_statement(status);
					expect("}", status);
					status.stack.pop();
				} else {
					func.has_body = true;
					func.has_return = true;
					func.is_arrow_body = true;
					const return_expr = parse_expression(status);
					func.statements.push(new ReturnNode(return_expr.start, return_expr));
				}
			} else {
				const has_body = parent.node_type === "trait" ? accept("{", status) : expect("{", status);
				if (has_body) {
					func.has_body = true;

					status.stack.push(func);
					parse_statement(status);
					expect("}", status);
					status.stack.pop();

					// Constructors, destructors and the construction markers
					// (Spawnable, WeakHandle, Handle) return through their own
					// machinery, not a Nomen `return`.
					if (
						name !== "#init" &&
						name !== "#destroy" &&
						name !== "#spawn" &&
						name !== "#weak" &&
						name !== "#handle"
					) {
						check_missing_return(func, status);
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

	// `mv out TYPE` — an ownership-transferring (owned) return. Distinguished
	// from a `mv TYPE name` parameter by the `out` that follows `mv`.
	const returns_move = peek_current(status) === "mv" && peek_next(status) === "out";
	if (returns_move) {
		accept("mv", status);
	}

	if (accept("out", status)) {
		func.return_type_start = get_index(status);
		// A func-typed return (`out func (out int)`): a closure factory's
		// return slot. The signature rides on the return Type
		// (Type.func_params / Type.func_return_type).
		if (at_func_type(status)) {
			consume(status);
			func.return_type = parse_func_type(status);
		} else {
			func.return_type = parse_type(status);
			// ERRORS_PLAN: the `!` form (`out string ! FetchError`, or the
			// composed `out string ! E1, E2`) — strip the parse marker,
			// record it on the function, and stamp the error set: the raw
			// member types for a composed set, or the error enum itself
			// (including an anonymous error set, `out T ! [.notfound]`).
			if (func.return_type.is_result_form) {
				func.returns_result = true;
				const err_slot = func.return_type.type_args?.[1];
				if (
					err_slot?.name === "anon_enum" &&
					err_slot.enum_cases?.length &&
					err_slot.is_composed_error_set
				) {
					func.result_error_types = err_slot.enum_cases.map((c) => c.types[0]);
				} else if (err_slot) {
					func.result_error_types = [err_slot];
				}
				func.return_type.is_result_form = undefined;
			}
			reject_void_type(func.return_type, status, func.return_type_start);
		}
		func.returns_move = returns_move;

		// Optional return contract: `out TYPE: out >= 0 && out < cap`
		// The placeholder `out` refers to the return value.
		if (accept(":", status)) {
			func.return_constraint = parse_expression(status);
		}

		if (accept(",", status) && peek_current(status) !== ")") {
			parse_function_parameter(parent, func, status);
		}
		return;
	}

	const param = new ParameterNode(param_start, "");
	func.params.push(param);

	if (accept("var", status)) {
		param.declaration = "var";
	} else if (accept("mv", status)) {
		param.declaration = "var";
		param.is_moved = true;
	}

	if (status.tokens[status.i]?.value === "ref" && status.tokens[status.i + 1]?.value === "self") {
		param.declaration = "var";
		param.is_ref = true;
		status.i += 2;
		param.name = "self";

		// Declared field set (FIELD_EFFECTS.md): `ref self { data }`.
		if (peek_current(status) === "{") {
			parse_field_set(param, status);
		}

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

		if (accept(",", status) && peek_current(status) !== ")") {
			parse_function_parameter(parent, func, status);
		}

		return;
	} else if (
		status.tokens[status.i]?.value === "self" &&
		(parent.node_type === "struct" || parent.node_type === "trait" || parent.node_type === "extend")
	) {
		// `var self` / `cp self` / `mv self` are rejected: use `ref self`
		// for mutation (visible to the caller) or bare `self` (read-only; in
		// `#init` it may assign fields). A declaration keyword consumed above
		// (var/cp/mv all set declaration="var") is detectable here because a
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

		// `self { … }` — a field set refines a MUTABLE borrow; bare `self` is
		// a read-only receiver with nothing to declare.
		if (peek_current(status) === "{") {
			add_error(
				status,
				`a field set is only allowed on a 'ref' parameter — bare 'self' is a read-only receiver`,
				get_index(status),
			);
			parse_field_set_raw(status);
		}

		if (accept(":", status)) {
			param.constraint = parse_expression(status);
		}

		param.type_start = param.start;
		param.type = new Type((parent as StructNode).name);
		param.is_self_param = true;
		if (func.name === "#init") {
			param.declaration = "var";
		}

		if (accept(",", status) && peek_current(status) !== ")") {
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
		if (at_func_type(status)) {
			// A func-typed parameter (`func (int, out int) f`): the `func`
			// marker word is consumed here and the recursive signature —
			// itself nesting-capable — lands on the ParameterNode. `func?`
			// marks the parameter nullable (it may hold `null`).
			consume(status);
			param.type = new Type("func");
			if (accept("?", status)) {
				param.type.is_nullable = true;
			}
			parse_func_type_signature(param, status);
			param.name_start = get_index(status);
			param.name = consume_name(status);
		} else {
			param.type = parse_type(status);
			// A func-typed parameter keeps the func-param shape (signature
			// on the ParameterNode).
			adopt_func_param_type(param, param.type);

			const next = peek_current(status);
			if (next === "=" || next === ")" || next === "," || status.i >= status.tokens.length) {
				status.i = saved_i;
				status.errors.length = saved_errors_length;
				param.type = new Type("");
				param.type_start = undefined;
				param.name = consume_name(status);
			} else {
				param.name_start = get_index(status);
				param.name = consume_name(status);
			}
		}
	}

	// Declared field set (FIELD_EFFECTS.md): `ref Item item { name }`. The set
	// refines the MUTABLE borrow the `ref` spelling hands the callee, so it is
	// only meaningful on a `ref` parameter — anything else is an error (the
	// braces are still consumed so later errors stay in sync).
	if (peek_current(status) === "{") {
		const set_start = get_index(status);
		if (param.type.is_ref) {
			parse_field_set(param, status);
		} else {
			parse_field_set_raw(status);
			add_error(
				status,
				`a field set is only allowed on a 'ref' parameter — '${param.name}' is not a ref`,
				set_start,
			);
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

	if (accept(",", status) && peek_current(status) !== ")") {
		parse_function_parameter(parent, func, status);
	}
}

/**
 * The declared field set of a `ref` parameter (FIELD_EFFECTS.md):
 * `{ name, cache }`, `{}` (none — scalar writes only), or absent entirely
 * (wildcard — the parameter may displace anything). The set is stored on the
 * ParameterNode with the source offsets the editor quick fix needs to extend
 * it in place. The caller has verified the current token is `{`.
 */
function parse_field_set(param: ParameterNode, status: ParseStatus) {
	if (!accept("{", status)) return;
	param.field_set = [];
	const fields: string[] = [];
	const span_start = get_index(status);
	let span_end = span_start;
	if (!accept("}", status)) {
		for (;;) {
			const field_start = get_index(status);
			const field = consume_name(status);
			span_end = field_start + field.length;
			if (fields.includes(field)) {
				add_error(status, `Duplicate field '${field}' in the field set`, field_start);
			} else {
				fields.push(field);
			}
			if (!accept(",", status)) break;
			if (peek_current(status) === "}") break;
		}
		expect("}", status);
		param.field_set_span = { start: span_start, end: span_end };
	} else {
		// Empty braces: an empty span at the brace itself — the quick fix
		// inserts the fields inside the braces.
		param.field_set_span = { start: span_start, end: span_start };
	}
	param.field_set = fields;
}

/**
 * Error-recovery companion of `parse_field_set`: skip a brace set's tokens
 * without recording anything, after a set has already been rejected, so the
 * parameter list keeps parsing.
 */
function parse_field_set_raw(status: ParseStatus) {
	if (!accept("{", status)) return;
	while (status.i < status.tokens.length && peek_current(status) !== "}") {
		status.i += 1;
	}
	accept("}", status);
}
