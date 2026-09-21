import add_error from "../../add_error.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import Type from "../../nodes/Type.ts";
import parse_type from "../parse_type.ts";
import type ParseStatus from "../ParseStatus.ts";
import accept from "./accept.ts";
import consume from "./consume.ts";
import expect from "./expect.ts";
import get_index from "./get_index.ts";
import peek_current from "./peek_current.ts";

/**
 * Func TYPE grammar (CLOSURE.md, SPEC "Function-Typed Parameters"): the
 * keyword form `func (T1, T2, out R)` (return as a trailing `out`) and the
 * generic-looking alias `Func<T1, T2, R>` (result last, `void` for none)
 * both parse to the same signature Type. A func type may appear anywhere a
 * type may — as a parameter type, in a return slot, or nested to any depth
 * (`func (func (out int), out int)`, `Func<Func<int, int>, int>`).
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

/**
 * Reject `void` where it has no meaning. Only the last type argument of
 * `Func<...>` is allowed to be `void` (meaning: no result); a func type
 * with no result otherwise omits `out` entirely.
 */
export function reject_void_type(type: Type, status: ParseStatus, at: number): void {
	if (type.name !== "void") return;
	add_error(
		status,
		"`void` has no value — a func type with no result omits `out`, or writes `void` as the last type argument of `Func<...>`",
		at,
	);
}

/**
 * A func type parsed in a PARAMETER slot (the `Func<...>` alias desugars to a
 * Type) keeps its signature on the ParameterNode — the convention every
 * param consumer reads (`param.func_params` / `param.func_return_type`).
 * Returns true when `type` was a func type (and `param.type` was normalized
 * to the `func` marker).
 */
export function adopt_func_param_type(param: ParameterNode, type: Type): boolean {
	if (type.name !== "func") return false;
	param.type = new Type("func");
	param.func_params = type.func_params;
	param.func_return_type = type.func_return_type;
	return true;
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
 * A type appearing inside a signature: a plain type or a nested
 * `func (...)`. Used for both parameter slots and `out` return slots of
 * signature lists.
 */
export function parse_signature_type(status: ParseStatus): Type {
	if (at_func_type(status)) {
		consume(status);
		return parse_func_type(status);
	}
	const start = get_index(status);
	const type = parse_type(status);
	reject_void_type(type, status, start);
	return type;
}

/** One entry of a signature parameter list: `out <type>` (the return) or a
 *  bare-typed parameter `<type> [<name>]`, where <type> may itself be a
 *  nested `func (...)` (whose signature lands on the ParameterNode — the
 *  convention every param consumer reads). */
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
		} else {
			param.type = parse_type(status);
			adopt_func_param_type(param, param.type);
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
