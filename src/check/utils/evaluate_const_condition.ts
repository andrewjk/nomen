import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import { expr_to_string, lookup_buffer_cap, numeric_interval } from "./flow_bounds.ts";

/**
 * Parse a bound expression string of the form `name`, `name + c`, or
 * `name - c` into {base, offset}. Used for symbolic bound implication:
 * `i < base - 5` implies `i < base - 1` (same base, -5 <= -1). Returns
 * undefined for expressions that aren't a single variable plus an offset
 * (e.g. `self.items.cap`).
 */
function parse_offset_expr(expr: string): { base: string; offset: number } | undefined {
	let m = expr.match(/^(\w+(?:\.\w+)*)\s*-\s*(\d+)$/);
	if (m) return { base: m[1], offset: -parseInt(m[2], 10) };
	m = expr.match(/^(\w+(?:\.\w+)*)\s*\+\s*(\d+)$/);
	if (m) return { base: m[1], offset: parseInt(m[2], 10) };
	m = expr.match(/^(\w+(?:\.\w+)*)$/);
	if (m) return { base: m[1], offset: 0 };
	return undefined;
}

/**
 * Symbolic upper-bound implication: does `x < U` (or `x <= U`) guarantee
 * `x < target`? When both are `base ± c` forms with the same base, yes iff
 * U's offset <= target's offset (e.g. `x < len - 5` ⇒ `x < len - 1`).
 */
function upper_implies(bound_expr: string, target: string): boolean {
	const b = parse_offset_expr(bound_expr);
	const t = parse_offset_expr(target);
	if (!b || !t) return false;
	if (b.base !== t.base) return false;
	return b.offset <= t.offset;
}

/**
 * Symbolic lower-bound implication: does `x > L` (or `x >= L`) guarantee
 * `x > target`? Same base iff L's offset >= target's offset.
 */
function lower_implies(bound_expr: string, target: string): boolean {
	const b = parse_offset_expr(bound_expr);
	const t = parse_offset_expr(target);
	if (!b || !t) return false;
	if (b.base !== t.base) return false;
	return b.offset >= t.offset;
}

/**
 * Try to evaluate a condition at compile time.
 * Returns `true` if always true, `false` if always false, `undefined` if unknown.
 */
export default function evaluate_const_condition(
	node: import("../../nodes/BaseNode.ts").default,
	status: CheckStatus,
): boolean | undefined | "unsafe" {
	if (node.node_type === "value") {
		return evaluate_value(node as ValueNode, status);
	}

	if (node.node_type === "op") {
		return evaluate_operation(node as OperationNode, status);
	}

	return undefined;
}

function evaluate_value(vn: ValueNode, status: CheckStatus): boolean | undefined | "unsafe" {
	if (vn.value === "true") return true;
	if (vn.value === "false") return false;

	// Look up const variable
	const decl = status.values.findLast((v) => v.name === vn.value);
	if (decl?.const_value !== undefined && typeof decl.const_value === "boolean") {
		return decl.const_value;
	}

	return undefined;
}

function evaluate_operation(
	op: OperationNode,
	status: CheckStatus,
): boolean | undefined | "unsafe" {
	// Check flow-sensitive bounds: if left side is a variable (or field access)
	// with a known upper/lower bound expression matching the right side,
	// the comparison is true.
	// E.g. inside `while j < list.length`, j has upper_bound_expr = "list.length",
	// so `j < self.length` (where self = list) evaluates to true.
	// Also handles field accesses: `self.length < self.items.cap` resolves
	// "self.length" as a variable name and checks its bounds.
	// Also handles literal < field access: `0 < self.values.cap` resolves
	// the field access via buffer_caps and evaluates numerically.
	if (op.op === "<" || op.op === "<=" || op.op === ">" || op.op === ">=") {
		// Numeric range path: evaluate the comparison using the variable's
		// proven numeric interval [lower, upper) and the right side's numeric
		// value. This handles offset accesses like `arr.at(i - 1)` and loop
		// bounds that resolve to constants. Returns true/false/undefined; a
		// strict upper bound that allows the index to equal the length is
		// "unsafe" (off-by-one OOB).
		const num = evaluate_numeric_comparison(op, status);
		if (num !== undefined) return num;
		let left_var: string | undefined;
		let left_offset = 0;
		if (op.left_value.node_type === "value") {
			left_var = (op.left_value as ValueNode).value;
		} else if (op.left_value.node_type === "access") {
			left_var = expr_to_string(op.left_value, status);
		} else if (op.left_value.node_type === "op") {
			const lop = op.left_value as OperationNode;
			if (lop.op === "+" || lop.op === "-") {
				if (
					lop.left_value.node_type === "value" &&
					/^[+-]?\d+$/.test((lop.left_value as ValueNode).value)
				) {
					left_offset = parseInt((lop.left_value as ValueNode).value, 10);
					if (lop.op === "-") left_offset = -left_offset;
					if (lop.right_value.node_type === "value")
						left_var = (lop.right_value as ValueNode).value;
				} else if (
					lop.right_value.node_type === "value" &&
					/^[+-]?\d+$/.test((lop.right_value as ValueNode).value)
				) {
					left_offset = parseInt((lop.right_value as ValueNode).value, 10);
					if (lop.op === "-") left_offset = -left_offset;
					if (lop.left_value.node_type === "value") left_var = (lop.left_value as ValueNode).value;
				}
			}
		}

		let left_decl: ReturnType<typeof status.values.findLast> | undefined;
		if (left_var) {
			left_decl = status.values.findLast((v) => v.name === left_var);
			// For dotted names like "self.length", bounds are stored on the base
			// variable "self" with key "self.length" in upper_bound_exprs.
			if (!left_decl && left_var.includes(".")) {
				const base = left_var.split(".")[0];
				left_decl = status.values.findLast((v) => v.name === base);
			}
			const right_str = expr_to_string(op.right_value, status);
			// When the left operand carries a constant offset (e.g. `at(i + 1)`
			// checks `i + 1 < len`), shift the target by the same offset so we
			// compare against the stored bound on the bare variable `i`.
			let target_str = right_str;
			if (target_str && left_offset !== 0) {
				target_str = `${target_str} ${left_offset >= 0 ? "-" : "+"} ${Math.abs(left_offset)}`;
			}

			if (op.op === "<" || op.op === "<=") {
				if (left_decl?.upper_bound_exprs?.length && target_str) {
					if (left_decl.upper_bound_exprs.includes(target_str)) return true;
					// Symbolic: a tighter stored bound (e.g. `len - 5`) implies a
					// looser target (e.g. `len - 1`).
					if (left_decl.upper_bound_exprs.some((u) => upper_implies(u, target_str!))) return true;
					// Transitive: a bound `x < V` plus `V < target` (where V is a
					// variable with its own upper bound) implies `x < target`.
					// E.g. `for i of 0 .. n` (i < n) inside `if n < arr.length`
					// (n < arr.length) ⇒ i < arr.length.
					for (const u of left_decl.upper_bound_exprs) {
						const v = parse_offset_expr(u);
						if (v && v.offset === 0 && u !== target_str) {
							const vdecl = status.values.findLast((vv) => vv.name === v.base);
							if (vdecl?.upper_bound_exprs?.includes(target_str!)) return true;
							if (vdecl?.upper_bound_inclusive_exprs?.includes(target_str!) && op.op === "<=") {
								return true;
							}
							// Transitive through inclusive: `i < n` (strict) and
							// `n <= target` together imply `i < target` (since
							// i < n <= target ⇒ i < target). This lets a hoisted
							// `if n <= buf.cap { while i < n { buf.load(i) } }`
							// verify without per-iteration guards.
							if (op.op === "<" && vdecl?.upper_bound_inclusive_exprs?.includes(target_str!)) {
								return true;
							}
						}
					}
				}
				// An inclusive upper bound (`x <= E`) only satisfies an
				// inclusive constraint (`x <= E`), NOT a strict one
				// (`x < E`) — otherwise `x <= len` would wrongly
				// satisfy `x < len` and miss an off-by-one OOB.
				if (op.op === "<=" && left_decl?.upper_bound_inclusive_exprs?.length && target_str) {
					if (left_decl.upper_bound_inclusive_exprs.includes(target_str)) return true;
				}
				// Off-by-one: a STRICT constraint `x < E` is guarded
				// only by an INCLUSIVE bound `x <= E` on the SAME E. That
				// bound allows `x == E`, which violates `x < E`, so the
				// access can read/write one element past the end. Flag it as
				// provably unsafe (the call site rejects it for every type).
				if (
					op.op === "<" &&
					left_decl?.upper_bound_inclusive_exprs?.length &&
					target_str &&
					left_decl.upper_bound_inclusive_exprs.includes(target_str)
				) {
					return "unsafe";
				}
				if (left_decl?.upper_bound_expr && target_str) {
					// Only a STRICT upper bound (`x < E`) may satisfy a strict
					// constraint; an inclusive bound (`x <= E`, stored only in
					// upper_bound_inclusive_exprs and mirrored in upper_bound_expr
					// for back-compat) must NOT satisfy `x < E` (off-by-one OOB).
					if (
						target_str === left_decl.upper_bound_expr &&
						left_decl.upper_bound_exprs?.includes(target_str)
					) {
						return true;
					}
					if (
						left_decl.upper_bound_exprs?.includes(target_str) ||
						left_decl.upper_bound_exprs?.some((u) => upper_implies(u, target_str))
					) {
						return true;
					}
				}
			}
			if (op.op === ">" || op.op === ">=") {
				if (left_decl?.lower_bound_exprs?.length && target_str) {
					if (left_decl.lower_bound_exprs.includes(target_str)) return true;
					if (left_decl.lower_bound_exprs.some((l) => lower_implies(l, target_str!))) return true;
				}
				if (op.op === ">=" && left_decl?.lower_bound_inclusive_exprs?.length && target_str) {
					if (left_decl.lower_bound_inclusive_exprs.includes(target_str)) return true;
				}
				if (left_decl?.lower_bound_expr && right_str) {
					if (right_str === left_decl.lower_bound_expr) return true;
				}
			}
		}

		// Symmetric case: literal OP variable/access (e.g. `0 < list.count`, or
		// `idx < list.count` where idx is a compile-time constant). The left
		// side is effectively a literal, so flip the operator and check the
		// right side's flow bound: `0 < list.count` ⟺ `list.count > 0`,
		// satisfied when `list.count` has a known lower bound of 0.
		const left_const =
			left_decl && typeof left_decl.const_value === "number"
				? String(left_decl.const_value)
				: !left_decl
					? expr_to_string(op.left_value, status)
					: undefined;
		if (left_const !== undefined) {
			let right_var: string | undefined;
			if (op.right_value.node_type === "value") {
				right_var = (op.right_value as ValueNode).value;
			} else if (op.right_value.node_type === "access") {
				right_var = expr_to_string(op.right_value, status);
			}
			if (right_var) {
				let rdecl = status.values.findLast((v) => v.name === right_var);
				if (!rdecl && right_var.includes(".")) {
					rdecl = status.values.findLast((v) => v.name === right_var.split(".")[0]);
				}
				if (rdecl) {
					const flipped = op.op === "<" ? ">" : op.op === "<=" ? ">=" : op.op === ">" ? "<" : "<=";
					if (flipped === "<" || flipped === "<=") {
						if (rdecl.upper_bound_exprs?.includes(left_const)) return true;
						if (flipped === "<=" && rdecl.upper_bound_inclusive_exprs?.includes(left_const)) {
							return true;
						}
						if (rdecl.upper_bound_expr === left_const) return true;
					} else {
						if (rdecl.lower_bound_exprs?.includes(left_const)) return true;
						if (flipped === ">=" && rdecl.lower_bound_inclusive_exprs?.includes(left_const)) {
							return true;
						}
						if (rdecl.lower_bound_expr === left_const) return true;
					}
				}
			}
		}

		// Literal < field access: `0 < self.values.cap` — resolve the field
		// access via buffer_caps and evaluate numerically.
		const left_num = evaluate_numeric_or_bool(op.left_value, status);
		const right_num = evaluate_numeric_or_bool(op.right_value, status);
		if (typeof left_num === "number" && typeof right_num === "number") {
			switch (op.op) {
				case "<":
					return left_num < right_num;
				case "<=":
					return left_num <= right_num;
				case ">":
					return left_num > right_num;
				case ">=":
					return left_num >= right_num;
			}
		}
	}

	// Three-valued logic for && and ||: only need both sides resolved for true &&
	// true; a single false makes && false; a single true makes || true.
	// A provable off-by-one ("unsafe") on either side propagates out,
	// since an OOB-guarding constraint that's provably unsafe must reject.
	if (op.op === "&&" || op.op === "||") {
		const left = evaluate_const_condition(op.left_value, status);
		const right = evaluate_const_condition(op.right_value, status);
		if (op.op === "&&") {
			if (left === false || right === false) return false;
			if (left === "unsafe" || right === "unsafe") return "unsafe";
			if (left === true && right === true) return true;
			return undefined;
		} else {
			if (left === true || right === true) return true;
			if (left === false && right === false) return false;
			if (left === "unsafe" || right === "unsafe") return "unsafe";
			return undefined;
		}
	}

	// Check if left side is a variable with range bounds (from for-loop)
	if (op.left_value.node_type === "value") {
		const vn = op.left_value as ValueNode;
		const decl = status.values.findLast((v) => v.name === vn.value);
		if (decl && (decl.range_lower !== undefined || decl.range_upper !== undefined)) {
			const right_val = evaluate_numeric_or_bool(op.right_value, status);
			if (right_val !== undefined && typeof right_val === "number") {
				return evaluate_range_bound(decl, op.op, right_val);
			}
		}
	}

	const left = evaluate_numeric_or_bool(op.left_value, status);
	const right = evaluate_numeric_or_bool(op.right_value, status);

	if (left === undefined || right === undefined) return undefined;

	switch (op.op) {
		case "<":
			return (left as number) < (right as number);
		case ">":
			return (left as number) > (right as number);
		case "<=":
			return (left as number) <= (right as number);
		case ">=":
			return (left as number) >= (right as number);
		case "==":
			return left === right;
		case "!=":
			return left !== right;
		default:
			return undefined;
	}

	/**
	 * Evaluate a comparison using numeric intervals so offset accesses
	 * (`arr.at(i - 1)`) and constant-resolvable loop bounds verify.
	 *
	 * Decomposes the left operand into `v + c` (or bare `v`, c = 0) where `v`
	 * is a variable with a known numeric interval [vlo, vhi). The right side is
	 * resolved to a number (literal, const, or fixed array length). Returns
	 * `true`/`false`/`undefined`/`"unsafe"`. Off-by-one: a strict upper bound
	 * (`v + c < len`) is "unsafe" when `max(v) + c == len` (the access can
	 * read/write one past the end). Returns undefined when either side can't
	 * be resolved numerically (falls back to the string-based flow logic).
	 */
	function evaluate_numeric_comparison(
		op: OperationNode,
		status: CheckStatus,
	): boolean | undefined | "unsafe" {
		// Decompose left into (variable, offset)
		let var_name: string | undefined;
		let offset = 0;
		const left = op.left_value;
		if (left.node_type === "value") {
			var_name = (left as ValueNode).value;
		} else if (left.node_type === "op") {
			const lop = left as OperationNode;
			if (lop.op === "+" || lop.op === "-") {
				const lc = int_literal_node(lop.left_value);
				const rc = int_literal_node(lop.right_value);
				if (lc !== undefined && lop.right_value.node_type === "value") {
					var_name = (lop.right_value as ValueNode).value;
					offset = lop.op === "+" ? lc : -lc;
				} else if (rc !== undefined && lop.left_value.node_type === "value") {
					var_name = (lop.left_value as ValueNode).value;
					offset = lop.op === "+" ? rc : -rc;
				}
			}
		} else if (left.node_type === "access") {
			var_name = expr_to_string(left, status);
		}
		if (!var_name) return undefined;
		const vdecl = status.values.findLast((v) => v.name === var_name);
		if (!vdecl) return undefined;
		// variable may itself be an alias of `arr.length` etc.; resolve its
		// interval directly when it has a numeric range.
		const vint =
			vdecl.range_lower !== undefined && vdecl.range_upper !== undefined
				? { lower: vdecl.range_lower, upper: vdecl.range_upper }
				: numeric_interval(left, status);
		if (!vint) return undefined;

		// Resolve the right side to a number.
		const rint = numeric_interval(op.right_value, status);
		if (!rint) return undefined;
		// When the right side is itself an interval (e.g. `arr.length` on a
		// fixed array → [len, len+1)), use its lower bound as the concrete value.
		const r = op.op === "<" || op.op === "<=" ? rint.lower : rint.lower;

		// max/min of (v + offset)
		const max_v = vint.upper - 1 + offset;
		const min_v = vint.lower + offset;

		switch (op.op) {
			case "<":
				// v + c < r  ⟺  max(v + c) < r  (strict)
				if (max_v < r) return true;
				if (max_v >= r) return max_v === r ? "unsafe" : false;
				return undefined;
			case "<=":
				if (max_v <= r) return true;
				return undefined;
			case ">":
				if (min_v > r) return true;
				return undefined;
			case ">=":
				if (min_v >= r) return true;
				if (min_v < r) return min_v === r ? "unsafe" : false;
				return undefined;
			default:
				return undefined;
		}
	}

	function int_literal_node(node: import("../../nodes/BaseNode.ts").default): number | undefined {
		if (node.node_type === "value") {
			const vn = node as ValueNode;
			if (/^[+-]?\d+$/.test(vn.value)) return parseInt(vn.value, 10);
		}
		return undefined;
	}

	/**
	 * Evaluate a comparison against a variable with range bounds (from a for-loop).
	 * The range is [range_lower, range_upper) — lower inclusive, upper exclusive.
	 */
	function evaluate_range_bound(
		decl: { range_lower?: number; range_upper?: number },
		op: string,
		right_val: number,
	): boolean | undefined {
		switch (op) {
			case ">=":
				return decl.range_lower !== undefined ? decl.range_lower >= right_val : undefined;
			case "<":
				// i < X: since i < range_upper (exclusive), need range_upper <= X
				return decl.range_upper !== undefined ? decl.range_upper <= right_val : undefined;
			case ">":
				return decl.range_lower !== undefined ? decl.range_lower > right_val : undefined;
			case "<=":
				// i <= X: max value is range_upper - 1, need range_upper - 1 <= X
				return decl.range_upper !== undefined ? decl.range_upper - 1 <= right_val : undefined;
			case "==":
				if (
					decl.range_lower !== undefined &&
					decl.range_upper !== undefined &&
					decl.range_lower === decl.range_upper - 1
				) {
					return decl.range_lower === right_val;
				}
				return undefined;
			case "!=":
				if (
					decl.range_lower !== undefined &&
					decl.range_upper !== undefined &&
					decl.range_lower === decl.range_upper - 1
				) {
					return decl.range_lower !== right_val;
				}
				return undefined;
			default:
				return undefined;
		}
	}
}

/**
 * Evaluate a node to a compile-time constant value.
 */
export function evaluate_numeric_or_bool(
	node: import("../../nodes/BaseNode.ts").default,
	status: CheckStatus,
): number | boolean | string | undefined {
	if (node.node_type === "value") {
		const vn = node as ValueNode;
		if (vn.value === "true") return true;
		if (vn.value === "false") return false;
		if (/^[+-]?\d+$/.test(vn.value)) return parseInt(vn.value, 10);
		if (/^[+-]?\d+\.\d+$/.test(vn.value)) return parseFloat(vn.value);

		// Look up const variable
		const decl = status.values.findLast((v) => v.name === vn.value);
		return decl?.const_value;
	}

	// Handle property access, e.g. source.length on an array
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const field = access.access as AccessFieldNode;
			if (field.name === "length") {
				// Evaluate the target and check if it's an array with a known length
				const target = evaluate_numeric_or_bool(access.target, status);
				if (target !== undefined) return target;
				// Look up the type to find array length
				if (access.target.node_type === "value") {
					const vn = access.target as ValueNode;
					const decl = status.values.findLast((v) => v.name === vn.value);
					if (decl?.type?.length) {
						const len_node = decl.type.length as ValueNode;
						const len = parseInt(len_node.value, 10);
						if (!isNaN(len)) return len;
					}
				}
			}
			if (field.name === "cap") {
				// Resolve `X.cap` to the minimum known capacity from recent
				// grow/alloc calls. Look up by the *target* path (e.g. "buf"),
				// not "buf.cap", since record_buffer_cap stores by buffer path.
				const target_path = expr_to_string(access.target, status);
				if (target_path) {
					const cap = lookup_buffer_cap(target_path, status);
					if (cap !== undefined) return cap;
					// Fallback: inside struct methods, buffer_caps are recorded under
					// the callee's "self.X" path, but the constraint evaluator resolves
					// via the caller's alias (e.g. "list.X"). Try "self.X" as fallback.
					if (target_path.includes(".")) {
						const dot_idx = target_path.indexOf(".");
						const fallback = "self" + target_path.slice(dot_idx);
						if (fallback !== target_path) {
							const cap2 = lookup_buffer_cap(fallback, status);
							if (cap2 !== undefined) return cap2;
						}
					}
				}
			}
		}
	}

	// Handle nested operations (e.g. i >= 0 inside x && y)
	if (node.node_type === "op") {
		const op_node = node as OperationNode;
		// Arithmetic operations: resolve to a numeric value
		if (op_node.op === "+" || op_node.op === "-" || op_node.op === "*" || op_node.op === "/") {
			const left = evaluate_numeric_or_bool(op_node.left_value, status);
			const right = evaluate_numeric_or_bool(op_node.right_value, status);
			if (typeof left === "number" && typeof right === "number") {
				switch (op_node.op) {
					case "+":
						return left + right;
					case "-":
						return left - right;
					case "*":
						return left * right;
					case "/":
						return right !== 0 ? left / right : undefined;
				}
			}
			return undefined;
		}
		return evaluate_const_condition(op_node, status);
	}

	return undefined;
}
