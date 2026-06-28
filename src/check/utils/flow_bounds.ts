import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";

/**
 * Serialize an AST expression to a canonical string for comparison.
 * E.g. `list.length` → "list.length", `self.length` → resolves alias to actual var.
 */
export function expr_to_string(node: BaseNode, status?: CheckStatus): string | undefined {
	if (node.node_type === "value") {
		const vn = node as ValueNode;
		if (status) {
			const decl = status.values.findLast((v) => v.name === vn.value);
			if (decl?.alias_of) return decl.alias_of;
		}
		return vn.value;
	}
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const target = expr_to_string(access.target, status);
			const field = (access.access as AccessFieldNode).name;
			if (target) return `${target}.${field}`;
		}
	}
	return undefined;
}

/**
 * Extract flow-sensitive bounds from a comparison condition.
 * E.g. `j < list.length` → { var: "j", op: "<", expr: "list.length" }
 * Returns undefined if the condition isn't a simple var-vs-expr comparison.
 */
export function extract_bound(
	condition: BaseNode,
	status?: CheckStatus,
): { var_name: string; op: string; expr: string } | undefined {
	if (condition.node_type !== "op") return undefined;
	const op = condition as OperationNode;

	if (op.op !== "<" && op.op !== "<=" && op.op !== ">" && op.op !== ">=") return undefined;

	// Try var OP expr (e.g. j < list.length)
	if (op.left_value.node_type === "value") {
		const var_name = (op.left_value as ValueNode).value;
		const expr = expr_to_string(op.right_value, status);
		if (expr) return { var_name, op: op.op, expr };
	}

	// Try expr OP var (e.g. list.length > j → j < list.length)
	if (op.right_value.node_type === "value") {
		const var_name = (op.right_value as ValueNode).value;
		const expr = expr_to_string(op.left_value, status);
		if (expr) {
			// Flip the operator
			const flipped = op.op === "<" ? ">" : op.op === "<=" ? ">=" : op.op === ">" ? "<" : "<=";
			return { var_name, op: flipped, expr };
		}
	}

	return undefined;
}

/**
 * Apply extracted bounds to the status's values.
 * Call this when entering an if/while body where the condition establishes bounds.
 */
export function apply_bounds(condition: BaseNode, status: CheckStatus) {
	// Handle && conditions (e.g. j >= 0 && j < list.length)
	if (condition.node_type === "op") {
		const op = condition as OperationNode;
		if (op.op === "&&") {
			apply_bounds(op.left_value, status);
			apply_bounds(op.right_value, status);
			return;
		}
	}

	const bound = extract_bound(condition, status);
	if (!bound) return;

	const var_decl = status.values.find((v) => v.name === bound.var_name);
	if (!var_decl) return;

	if (bound.op === "<") {
		var_decl.upper_bound_expr = bound.expr;
	} else if (bound.op === "<=") {
		var_decl.upper_bound_expr = bound.expr;
	} else if (bound.op === ">") {
		var_decl.lower_bound_expr = bound.expr;
	} else if (bound.op === ">=") {
		var_decl.lower_bound_expr = bound.expr;
	}
}

/**
 * Clear flow-sensitive bounds on a variable (call on reassignment).
 */
export function clear_bounds(name: string, status: CheckStatus) {
	const decl = status.values.findLast((v) => v.name === name);
	if (decl) {
		decl.upper_bound_expr = undefined;
		decl.lower_bound_expr = undefined;
	}
}

/**
 * Track flow-sensitive knowledge gained from a declaration/assignment.
 * Currently handles:
 *   - `var int x = a % b`        → x.range_lower = 0, x.range_upper = b
 *                                  (when b is a known positive constant)
 *   - `var int x = N`            → x.range_lower = N, x.range_upper = N + 1
 *                                  (the value IS N, until reassigned)
 *
 * Buffer capacity is read directly as a public field (`buf.cap`), so no alias
 * tracking is needed — `expr_to_string` already resolves `buf.cap` to the
 * canonical "buf.cap" string used by the flow analysis.
 *
 * Call this AFTER the variable has been pushed to status.values.
 */
export function track_assignment_bounds(var_name: string, value: BaseNode, status: CheckStatus) {
	const decl = status.values.findLast((v) => v.name === var_name);
	if (!decl) return;

	// 1) Modulo range: `var int idx = a % b` → 0 <= idx < b
	//    (only when b is a positive compile-time constant)
	if (value.node_type === "op") {
		const op = value as OperationNode;
		if (op.op === "%") {
			const right_const = int_literal(op.right_value);
			if (right_const !== undefined && right_const > 0) {
				decl.range_lower = 0;
				decl.range_upper = right_const;
			} else if (op.right_value.node_type === "value") {
				// b is a runtime variable; track its bound if known
				const right_name = (op.right_value as ValueNode).value;
				const right_decl = status.values.findLast((v) => v.name === right_name);
				if (right_decl?.const_value !== undefined && typeof right_decl.const_value === "number") {
					if (right_decl.const_value > 0) {
						decl.range_lower = 0;
						decl.range_upper = right_decl.const_value;
					}
				}
			}
		}
	}

	// 2) Literal initialization: `var int i = 5` → range [5, 6), so the value
	//    is provably 5. Cleared on reassignment by check_assignment_node.
	const lit = int_literal(value);
	if (lit !== undefined) {
		decl.range_lower = lit;
		decl.range_upper = lit + 1;
	}
}

function int_literal(node: BaseNode): number | undefined {
	if (node.node_type === "value") {
		const vn = node as ValueNode;
		if (/^[+-]?\d+$/.test(vn.value)) return parseInt(vn.value, 10);
	}
	return undefined;
}

/**
 * Apply the NEGATION of a comparison condition as bounds (post-loop).
 * E.g. after `while idx >= cap`, we know `idx < cap` in the parent scope.
 * Only handles single comparisons (not && / ||).
 */
export function apply_negated_bounds(condition: BaseNode, status: CheckStatus) {
	if (condition.node_type !== "op") return;
	const op = condition as OperationNode;
	if (op.op !== "<" && op.op !== "<=" && op.op !== ">" && op.op !== ">=") return;

	// Determine the variable and the expression it's compared against
	let var_name: string | undefined;
	let expr: string | undefined;
	if (op.left_value.node_type === "value") {
		var_name = (op.left_value as ValueNode).value;
		expr = expr_to_string(op.right_value, status);
	} else if (op.right_value.node_type === "value") {
		var_name = (op.right_value as ValueNode).value;
		expr = expr_to_string(op.left_value, status);
	}
	if (!var_name || !expr) return;

	const var_decl = status.values.findLast((v) => v.name === var_name);
	if (!var_decl) return;

	// Negate the operator: while(x < e) → after: x >= e (lower bound)
	//                   while(x >= e) → after: x < e (upper bound)
	// We need to be careful about which side the variable is on.
	const left_is_var = op.left_value.node_type === "value";
	// Compute the negated relation from the variable's perspective
	let rel: "<" | "<=" | ">" | ">=";
	if (left_is_var) {
		// var OP expr  →  negate(OP)
		rel = op.op === "<" ? ">=" : op.op === "<=" ? ">" : op.op === ">" ? "<=" : ">=";
	} else {
		// expr OP var  →  flip then negate
		// var originally was on the right; from var's perspective op is flipped
		const flipped = op.op === "<" ? ">" : op.op === "<=" ? ">=" : op.op === ">" ? "<" : "<=";
		rel = flipped === "<" ? ">=" : flipped === "<=" ? ">" : flipped === ">" ? "<=" : "<";
	}

	if (rel === "<" || rel === "<=") {
		var_decl.upper_bound_expr = expr;
	} else {
		var_decl.lower_bound_expr = expr;
	}
}

/**
 * Record that the buffer at `path` (e.g. "buf", "self.items") has had a
 * grow/alloc call ensuring its capacity is at least `min_cap`.
 * Takes the max with any existing value (grow_monotonic invariant).
 */
export function record_buffer_cap(path: string, min_cap: number, status: CheckStatus) {
	if (!status.buffer_caps) status.buffer_caps = new Map();
	const existing = status.buffer_caps.get(path);
	if (existing === undefined || min_cap > existing) {
		status.buffer_caps.set(path, min_cap);
	}
}

/**
 * Look up the minimum known capacity for a buffer at `path`.
 * Returns undefined if no grow/alloc has been recorded.
 */
export function lookup_buffer_cap(path: string, status: CheckStatus): number | undefined {
	return status.buffer_caps?.get(path);
}

/**
 * Clear buffer cap tracking for `path` (call when the buffer variable is
 * reassigned, since the new buffer may have a different cap).
 */
export function clear_buffer_cap(path: string, status: CheckStatus) {
	status.buffer_caps?.delete(path);
}
