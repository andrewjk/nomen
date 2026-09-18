import add_error from "../../add_error.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import type StackValue from "../StackValue.ts";
import { is_class_type, is_owning_struct_type } from "./ownership.ts";

/**
 * Closure capture analysis (docs/CLOSURE_PLAN.md Phase 2). Called from
 * `type_from_value` — the value-resolution funnel — so EVERY reference form is
 * covered (plain reads, method receivers like `n.to_string()`, assignment
 * targets), not just check_value_node's read path.
 *
 * Supported: SCALAR copy-captures (Phase 2a) and OWNED string captures
 * (Phase 2b, strdup'd into the env with a per-lambda env destructor).
 * Everything else is rejected with a specific reason: borrowed parameters
 * (`ref`/`var`), arrays/views/pointers, owning structs/classes/traits (move
 * captures), and nested closures.
 */
export function capture_rejection(value: StackValue, status: CheckStatus): string | undefined {
	const type = value.type;
	if (type.is_ref) return "a `ref`/`var` parameter is a borrow — capturing borrows comes later";
	if (type.is_view) return "views are borrowed slices";
	if (type.is_array) return "arrays are heap-backed";
	if (type.is_pointer) return "raw pointers are not capturable";
	if (type.name === "func") return "capturing a closure comes later";
	if (type.name === "null" || type.name === "void" || type.name === "?") {
		return `a ${type.name} value is not capturable`;
	}
	if (is_class_type(type.name, status)) return "classes are owned — owned move captures come later";
	if (status.traits.find((t) => t.name === type.name)) return "traits are owned at runtime";
	if (is_owning_struct_type(type, status)) return "owning structs are not copyable";
	if (status.structs.find((s) => s.name === type.name && !s.is_simple_type)) {
		return "capturing a struct comes later";
	}
	return undefined;
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
		lambda.captures.push({ name, type: decl_value.type });
	}
	return true;
}
