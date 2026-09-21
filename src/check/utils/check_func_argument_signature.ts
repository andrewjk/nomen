import add_error from "../../add_error.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import type Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Func-value ARGUMENT signature checking (SPEC "Function-Typed Parameters").
 * Passing a lambda, named function, or func-typed value whose signature does
 * not match the callee's func-typed parameter is a compile error at the
 * argument site. Before this check the mismatch compiled and produced an ABI
 * mismatch (garbage) at runtime, because `type_from_value_node` of a lambda
 * is its RETURN type, so the scalar `check_type_and_value_match` comparison
 * could not apply.
 *
 * The comparison is deliberately conservative — it can only reject what it
 * can see:
 *   - arity, whenever both sides expose a parameter list;
 *   - each parameter's type NAME (skipped for unresolved generic type
 *     params, e.g. `T` inside a generic body, and for names the checker
 *     could not resolve);
 *   - the return type (absent/empty/`void` all mean "no result");
 *   - nested func parameters, recursively, when both sides carry a
 *     signature (a `func`-typed FIELD's value or a lossy binding drops it —
 *     then the nested level is skipped, never guessed).
 */

interface FuncParamLike {
	type?: Type;
	func_params?: FuncParamLike[];
	func_return_type?: Type;
}

interface FuncSignature {
	params?: FuncParamLike[];
	return_type?: Type;
}

/** One parameter's expected signature source: the ParameterNode fields, or
 *  (for `out`-position func types) the Type-level ones. */
interface ExpectedFuncParam {
	type?: Type;
	func_params?: FuncParamLike[];
	func_return_type?: Type;
}

/** `void`: absent, an empty name, or the explicit marker. */
function is_void(type: Type | undefined): boolean {
	return !type || !type.name || type.name === "void";
}

/** The comparable name of a type, or undefined when it cannot be compared
 *  (unresolved generic type param, or no name). */
function comparable_name(type: Type | undefined, status: CheckStatus): string | undefined {
	const name = type?.name;
	if (!name || name === "void") return undefined;
	if (status.type_params.includes(name)) return undefined;
	return name;
}

/**
 * The signature an argument expression carries, or undefined when it cannot
 * be resolved (a func-typed field's value, a generic body, an arbitrary
 * expression) — in which case the comparison is skipped.
 */
function arg_signature(arg: BaseNode, status: CheckStatus): FuncSignature | undefined {
	if (arg.node_type === "func") {
		const fn = arg as FunctionNode;
		return { params: fn.params, return_type: fn.return_type };
	}
	if (arg.node_type === "value") {
		const name = (arg as { value?: string }).value;
		if (!name) return undefined;
		const sv = status.values.findLast((v) => v.name === name);
		if (sv?.func_params !== undefined) {
			// A func-typed binding: the StackValue carries the top-level
			// signature (nested func params are not preserved there).
			return {
				params: sv.func_params as unknown as FuncParamLike[],
				return_type: sv.func_return_type,
			};
		}
		// A shadowing non-func local is NOT a function reference.
		if (sv) return undefined;
		const fn = status.functions.findLast((f) => f.name === name);
		if (fn) {
			return {
				params: fn.params.filter((p) => !p.is_self_param),
				return_type: fn.return_type,
			};
		}
		return undefined;
	}
	if (arg.node_type === "access") {
		const t = type_from_value_node(arg, status);
		if (t?.name === "func" && (t.func_params || t.func_return_type)) {
			return { params: t.func_params, return_type: t.func_return_type };
		}
	}
	return undefined;
}

function mismatch(
	expected: FuncSignature,
	actual: FuncSignature,
	status: CheckStatus,
	start: number,
): boolean {
	const expected_params = expected.params;
	const actual_params = actual.params;
	if (expected_params && actual_params && expected_params.length !== actual_params.length) {
		add_error(
			status,
			`Function signature mismatch: expected ${expected_params.length} parameter(s)`,
			start,
		);
		return true;
	}
	if (expected_params && actual_params && expected_params.length === actual_params.length) {
		for (let i = 0; i < expected_params.length; i++) {
			const want = expected_params[i];
			const got = actual_params[i];
			const want_name = comparable_name(want.type, status);
			const got_name = comparable_name(got.type, status);
			if (want_name && got_name && want_name !== got_name) {
				add_error(
					status,
					`Function signature mismatch: parameter ${i + 1} is ${got_name}, expected ${want_name}`,
					start,
				);
				return true;
			}
			// Nested func parameter: recurse when both sides carry one.
			if (want.func_params && got.func_params) {
				if (
					mismatch(
						{ params: want.func_params, return_type: want.func_return_type },
						{ params: got.func_params, return_type: got.func_return_type },
						status,
						start,
					)
				) {
					return true;
				}
			}
		}
	}
	const want_ret = comparable_name(expected.return_type, status);
	const got_ret = comparable_name(actual.return_type, status);
	// A missing/void return compares equal to another missing/void return;
	// a concrete return differs from `void`.
	const want_void = is_void(expected.return_type);
	const got_void = is_void(actual.return_type);
	if (want_void !== got_void || (want_ret && got_ret && want_ret !== got_ret)) {
		add_error(
			status,
			`Function signature mismatch: returns ${got_void ? "void" : got_ret}, expected ${
				want_void ? "void" : want_ret
			}`,
			start,
		);
		return true;
	}
	return false;
}

/**
 * Check one argument against the callee's func-typed parameter. `expected`
 * is the callee ParameterNode (its signature lives on `func_params` /
 * `func_return_type`, or on the Type for `out`-position func types). No-op
 * when either side's signature is unavailable.
 */
export default function check_func_argument_signature(
	expected: ExpectedFuncParam,
	arg: BaseNode,
	status: CheckStatus,
	start: number,
): void {
	const expected_sig: FuncSignature = {
		params: expected.func_params ?? expected.type?.func_params,
		return_type: expected.func_return_type ?? expected.type?.func_return_type,
	};
	// Without a declared signature there is nothing to compare against (a
	// bare `func` marker param).
	if (!expected_sig.params && !expected_sig.return_type) return;
	const actual_sig = arg_signature(arg, status);
	if (!actual_sig) return;
	mismatch(expected_sig, actual_sig, status, start);
}
