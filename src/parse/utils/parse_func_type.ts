import add_error from "../../add_error.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import Type from "../../nodes/Type.ts";
import { anonymous_function_body_start } from "../parse_expression.ts";
import parse_type from "../parse_type.ts";
import type ParseStatus from "../ParseStatus.ts";
import accept from "./accept.ts";
import consume from "./consume.ts";
import expect from "./expect.ts";
import get_index from "./get_index.ts";
import peek_current from "./peek_current.ts";

/**
 * Func TYPE grammar (CLOSURE.md, SPEC "Function-Typed Parameters"): two
 * interchangeable spellings for the same signature Type —
 *   - the keyword form `func (T1, T2, out R)` (return as a trailing `out`),
 *   - the arrow form `(T1, T2) => R` (return after `=>`).
 * Either may appear anywhere a type may: as a parameter type, in a return
 * slot (`out func (out int)` / `out () => int`), or nested inside the other
 * (`func ((int) => int, out int)`, `((int) => int) => int`), to any depth.
 * The representation mirrors the one-level convention:
 *   - a func-typed PARAMETER keeps its signature on the ParameterNode
 *     (`param.func_params` / `param.func_return_type`, each inner parameter
 *     itself recursively nestable);
 *   - a func RETURN carries its signature on the Type
 *     (`type.func_params` / `type.func_return_type`).
 */

/** Whether the current token starts a nested func type: `func` immediately
 *  followed by `(` (the bare word `func` alone is the plain marker type). */
export function at_func_type(status: ParseStatus): boolean {
	return peek_current(status) === "func" && status.tokens[status.i + 1]?.value === "(";
}

/** Whether the cursor is at an arrow func type — `( ... ) =>`. Uses the same
 *  matching-paren lookahead lambda EXPRESSIONS use to tell an arrow body from
 *  a parenthesized group. */
export function at_arrow_func_type(status: ParseStatus): boolean {
	return peek_current(status) === "(" && anonymous_function_body_start(status) === "=>";
}

/**
 * Parse `(` <signature params> `)` into `param`, whose `func` marker type
 * has already been consumed by the caller (via parse_type or at_func_type).
 * Fills `param.func_params` / `param.func_return_type` from the inner list.
 */
export function parse_func_type_signature(param: ParameterNode, status: ParseStatus): void {
	if (!expect("(", status)) return;
	const params: ParameterNode[] = [];
	if (peek_current(status) !== ")") {
		parse_signature_params(params, status);
	}
	expect(")", status);
	for (const p of params) {
		if (p.type.is_return_type) {
			param.func_return_type = p.type;
		} else {
			if (!param.func_params) param.func_params = [];
			param.func_params.push(p);
		}
	}
}

/**
 * Parse a full nested func type — the `func` word is consumed by the caller
 * (at_func_type confirmed the `(` follows) — and return it as a Type whose
 * func_params/func_return_type carry the signature.
 */
export function parse_func_type(status: ParseStatus): Type {
	const type = new Type("func");
	const param = new ParameterNode(get_index(status), "");
	parse_func_type_signature(param, status);
	type.func_params = param.func_params;
	type.func_return_type = param.func_return_type;
	return type;
}

/**
 * Parse an arrow func type — `(T1, T2) => R` — into the same signature Type
 * the keyword spelling produces. The parameter list holds bare types (a
 * parameter may itself be a func/arrow type); the return after `=>` may too.
 * `out` is not allowed in the list — the arrow spelling puts the return
 * after `=>` (an explicit error rather than a silent trailing-`out` parse).
 */
export function parse_arrow_func_type(status: ParseStatus): Type {
	const type = new Type("func");
	type.start = get_index(status);
	if (!expect("(", status)) return type;
	const params: ParameterNode[] = [];
	if (peek_current(status) !== ")") {
		parse_arrow_param_types(params, status);
	}
	expect(")", status);
	expect("=>", status);
	type.func_params = params;
	type.func_return_type = parse_signature_type(status);
	return type;
}

/** One entry of an arrow type's parameter list: a bare type, a nested
 *  `func (...)`, or a nested `( ... ) => ...`. */
function parse_arrow_param_types(params: ParameterNode[], status: ParseStatus): void {
	const param_start = get_index(status);
	if (accept("out", status)) {
		add_error(
			status,
			"an arrow func type puts its return type after '=>'; 'out' is not allowed in the parameter list",
			param_start,
		);
		// Recover: parse the type and discard the entry, keeping the token
		// stream in sync for the rest of the signature.
		parse_type(status);
	} else {
		const param = new ParameterNode(param_start, "");
		param.type_start = get_index(status);
		if (at_func_type(status)) {
			consume(status);
			param.type = new Type("func");
			parse_func_type_signature(param, status);
		} else if (at_arrow_func_type(status)) {
			const nested = parse_arrow_func_type(status);
			param.type = new Type("func");
			param.func_params = nested.func_params;
			param.func_return_type = nested.func_return_type;
		} else {
			param.type = parse_type(status);
		}
		params.push(param);
	}
	if (accept(",", status) && peek_current(status) !== ")") {
		parse_arrow_param_types(params, status);
	}
}

/**
 * A type appearing inside a signature: a plain type, a nested `func (...)`,
 * or an arrow func type `( ... ) => ...`. Used for both parameter slots and
 * `out` return slots of signature lists.
 */
export function parse_signature_type(status: ParseStatus): Type {
	if (at_func_type(status)) {
		consume(status);
		return parse_func_type(status);
	}
	if (at_arrow_func_type(status)) {
		return parse_arrow_func_type(status);
	}
	return parse_type(status);
}

/** One entry of a signature parameter list: `out <type>` (the return) or a
 *  bare-typed parameter `<type> [<name>]`, where <type> may itself be a
 *  nested `func (...)` or `( ... ) => ...` (whose signature lands on the
 *  ParameterNode — the convention every param consumer reads). */
export function parse_signature_params(params: ParameterNode[], status: ParseStatus): void {
	const param_start = get_index(status);

	if (accept("out", status)) {
		const return_type = parse_signature_type(status);
		return_type.is_return_type = true;
		const param = new ParameterNode(param_start, "", return_type);
		param.type.is_return_type = true;
		params.push(param);
	} else {
		const param = new ParameterNode(param_start, "");
		param.type_start = get_index(status);
		if (at_func_type(status)) {
			// A nested func parameter: consume the `func` marker word and
			// parse its signature onto the ParameterNode.
			consume(status);
			param.type = new Type("func");
			parse_func_type_signature(param, status);
		} else if (at_arrow_func_type(status)) {
			// An arrow func parameter: same landing spot.
			const nested = parse_arrow_func_type(status);
			param.type = new Type("func");
			param.func_params = nested.func_params;
			param.func_return_type = nested.func_return_type;
		} else {
			param.type = parse_type(status);
		}
		// Signature parameters are bare types; a following word is the
		// (optional) parameter name.
		const next = peek_current(status);
		if (next !== ")" && next !== "," && next !== "out" && status.i < status.tokens.length) {
			param.name_start = get_index(status);
			param.name = consume(status);
		}
		params.push(param);
	}

	if (accept(",", status) && peek_current(status) !== ")") {
		parse_signature_params(params, status);
	}
}
