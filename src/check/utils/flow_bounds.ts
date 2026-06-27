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
