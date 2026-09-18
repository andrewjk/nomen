import add_error from "../../add_error.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import type StackValue from "../StackValue.ts";
import { is_class_type, is_owning_struct_type_requiring_move } from "./ownership.ts";

/**
 * A func-typed variable's StackValue does NOT always carry type `func`: an
 * `out`-returning signature stores the RETURN type instead (`var func (out int)
 * f` stores `int`) and the signature lives on `func_params`/`func_return_type`
 * (mirrors the call resolver in check_function_call_node).
 */
function is_func_value(value: StackValue): boolean {
	return (
		value.type.name === "func" ||
		value.func_params !== undefined ||
		value.func_return_type !== undefined
	);
}

/** The StackValue's type normalized to `func` for a func-typed capture (so the
 *  backends emit a closure-descriptor env field, not the return type). */
function capture_type(value: StackValue): Type {
	return is_func_value(value) ? new Type("func") : value.type;
}

/**
 * Closure capture analysis (docs/CLOSURE_PLAN.md Phase 2). Called from
 * `type_from_value` — the value-resolution funnel — so EVERY reference form is
 * covered (plain reads, method receivers like `n.to_string()`, assignment
 * targets), not just check_value_node's read path.
 *
 * Supported:
 *   - SCALAR and non-owning value-struct COPY-captures (Phase 2a/2c): the env
 *     holds an independent snapshot (scalars by value, structs by malloc'd
 *     byte copy).
 *   - OWNED string captures (Phase 2b, strdup'd into the env with a per-lambda
 *     env destructor).
 *   - OWNING value structs, classes and func values (Phase 2c part 2): captured
 *     by MOVE — the donating local is invalidated (use-after-move) and the env
 *     destructor reclaims the transferred value.
 *
 * Everything else is rejected with a specific reason: borrowed parameters
 * (`ref`/`var`), arrays/views/pointers, traits (owned at runtime, dispatched
 * destruction is a follow-up), borrowed/aliased class references, and any
 * move-capture of a parameter (callee-owned; the caller's cleanup still runs).
 */
export function capture_rejection(value: StackValue, status: CheckStatus): string | undefined {
	const type = value.type;
	if (type.is_ref) return "a `ref`/`var` parameter is a borrow — capturing borrows comes later";
	if (type.is_view) return "views are borrowed slices";
	if (type.is_array) return "arrays are heap-backed";
	if (type.is_pointer) return "raw pointers are not capturable";
	if (type.name === "null" || type.name === "void" || type.name === "?") {
		return `a ${type.name} value is not capturable`;
	}
	if (is_func_value(value)) {
		// A func-valued local is move-captured (descriptor ownership). Its
		// StackValue type may be the RETURN type for an `out` signature, so it
		// must be classified before the class/trait checks below.
		if (value.is_param) return "capturing a function parameter by move comes later";
		return undefined;
	}
	if (status.traits.find((t) => t.name === type.name)) return "traits are owned at runtime";
	if (is_class_type(type.name, status)) {
		// A class value is a heap pointer: moving it transfers ownership. A
		// borrowed (field/container accessor) or aliased (`var Box b = a`)
		// reference is not the closure's to own and would double-free.
		if (value.borrow_depth !== undefined || value.borrowed_from || value.class_alias_of) {
			return "a borrowed class reference is not owned and cannot be captured";
		}
		if (value.is_param) return "capturing a class parameter by move comes later";
	}
	return undefined;
}

/**
 * Whether capturing `value` transfers ownership (MOVE) or snapshots it (COPY).
 * Owning value structs, classes and func values move; strings are deep-copied;
 * scalars and non-owning value structs copy. Kept in lockstep with
 * `capture_rejection` (rejections never reach here).
 */
function capture_is_move(value: StackValue, status: CheckStatus): boolean {
	if (is_func_value(value)) return true;
	const type = value.type;
	if (is_class_type(type.name, status)) return true;
	// String-only owning structs copy (their string fields are non-owning at
	// local scope exit — see ownership.ts), matching a plain local copy.
	return is_owning_struct_type_requiring_move(type, status);
}

/**
 * If `name` refers to an enclosing function's value while a closure lambda's
 * body is being checked, record it as a capture on that lambda (validating the
 * capture kind first). Returns true when the reference was an outer one — the
 * caller still resolves its type normally.
 */
export function maybe_record_capture(
	name: string,
	decl_value: StackValue,
	decl_index: number,
	status: CheckStatus,
): boolean {
	if (decl_index >= status.function_value_base || decl_value.is_global) return false;
	const lambda = status.enclosing_closure as FunctionNode | undefined;
	if (!lambda) return false; // plain nested function: check_value_node errors
	const unsupported = capture_rejection(decl_value, status);
	if (unsupported) {
		// Report once per (lambda, name) — type_from_value may run repeatedly
		// for the same reference.
		if (!status.reported_capture_errors) status.reported_capture_errors = new Set();
		const key = `${lambda.name ?? "<lambda>"}:${name}`;
		if (!status.reported_capture_errors.has(key)) {
			status.reported_capture_errors.add(key);
			add_error(
				status,
				`Cannot capture '${name}' in a closure: ${unsupported}`,
				decl_value.start ?? 0,
			);
		}
		return true;
	}
	if (!lambda.captures) lambda.captures = [];
	if (!lambda.captures.some((c) => c.name === name)) {
		lambda.captures.push({
			name,
			type: capture_type(decl_value),
			is_move: capture_is_move(decl_value, status) || undefined,
		});
	}
	return true;
}
