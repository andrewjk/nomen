import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import type { PathBounds } from "../StackValue.ts";

// Container fields whose values are always >= 0. Mirrors the same set in
// evaluate_const_condition.ts (kept duplicated to avoid a circular import).
const NON_NEGATIVE_FIELDS = new Set(["length", "cap", "count", "size"]);

/**
 * Snapshot of the flow-sensitive bound fields on a StackValue, captured
 * BEFORE the variable is reassigned (and its bounds cleared). Used by
 * `track_assignment_bounds` so `i = i + N` can still see `i`'s prior
 * bounds (e.g. `i >= 0`) when computing the shifted bound `i >= N`.
 */
export type BoundsSnapshot = {
	range_lower?: number;
	range_upper?: number;
	upper_bound_exprs?: string[];
	lower_bound_exprs?: string[];
	upper_bound_inclusive_exprs?: string[];
	lower_bound_inclusive_exprs?: string[];
};

/**
 * Capture a snapshot of `name`'s bounds from `status.values`. Returns
 * undefined when the variable doesn't exist. The snapshot is a shallow copy
 * of the bound fields — sufficient because the fields are always replaced
 * (not mutated in place) when cleared.
 */
export function snapshot_bounds(name: string, status: CheckStatus): BoundsSnapshot | undefined {
	const decl = status.values.findLast((v) => v.name === name);
	if (!decl) return undefined;
	return {
		range_lower: decl.range_lower,
		range_upper: decl.range_upper,
		upper_bound_exprs: decl.upper_bound_exprs?.slice(),
		lower_bound_exprs: decl.lower_bound_exprs?.slice(),
		upper_bound_inclusive_exprs: decl.upper_bound_inclusive_exprs?.slice(),
		lower_bound_inclusive_exprs: decl.lower_bound_inclusive_exprs?.slice(),
	};
}

/**
 * Snapshot of EVERY flow-bound field on EVERY value, keyed by StackValue
 * object identity. Used to make condition-position bound application
 * transient: bounds established by earlier `&&` operands (or the negation
 * of earlier `||` operands) are valid only while evaluating the remaining
 * operands of that same expression, so they are applied before checking the
 * right operand and restored afterwards.
 */
type FullBoundsSnapshot = BoundsSnapshot & {
	upper_bound_expr?: string;
	lower_bound_expr?: string;
	alias_of?: string;
	known_length?: number;
	path_bounds?: Map<string, PathBounds>;
};

export function snapshot_all_bounds(status: CheckStatus): Map<object, FullBoundsSnapshot> {
	const snap = new Map<object, FullBoundsSnapshot>();
	for (const v of status.values) {
		snap.set(v, {
			range_lower: v.range_lower,
			range_upper: v.range_upper,
			upper_bound_exprs: v.upper_bound_exprs?.slice(),
			lower_bound_exprs: v.lower_bound_exprs?.slice(),
			upper_bound_inclusive_exprs: v.upper_bound_inclusive_exprs?.slice(),
			lower_bound_inclusive_exprs: v.lower_bound_inclusive_exprs?.slice(),
			upper_bound_expr: v.upper_bound_expr,
			lower_bound_expr: v.lower_bound_expr,
			alias_of: v.alias_of,
			known_length: v.known_length,
			path_bounds: v.path_bounds ? new Map(v.path_bounds) : undefined,
		});
	}
	return snap;
}

export function restore_all_bounds(status: CheckStatus, snap: Map<object, FullBoundsSnapshot>) {
	for (const v of status.values) {
		const s = snap.get(v);
		if (!s) continue;
		v.range_lower = s.range_lower;
		v.range_upper = s.range_upper;
		v.upper_bound_exprs = s.upper_bound_exprs;
		v.lower_bound_exprs = s.lower_bound_exprs;
		v.upper_bound_inclusive_exprs = s.upper_bound_inclusive_exprs;
		v.lower_bound_inclusive_exprs = s.lower_bound_inclusive_exprs;
		v.upper_bound_expr = s.upper_bound_expr;
		v.lower_bound_expr = s.lower_bound_expr;
		v.alias_of = s.alias_of;
		v.known_length = s.known_length;
		v.path_bounds = s.path_bounds;
	}
}

/**
 * Serialize an AST expression to a canonical string for comparison.
 * E.g. `list.length` → "list.length", `self.length` → resolves alias to actual var.
 */
export function expr_to_string(node: BaseNode, status?: CheckStatus): string | undefined {
	if (node.node_type === "value") {
		const vn = node as ValueNode;
		if (status) {
			const decl = status.values.findLast((v) => v.name === vn.value);
			if (decl?.alias_of) return canonicalize_length_path(decl.alias_of, status);
		}
		return vn.value;
	}
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const target = expr_to_string(access.target, status);
			const field = (access.access as AccessFieldNode).name;
			if (target) {
				const path = `${target}.${field}`;
				return status ? canonicalize_length_path(path, status) : path;
			}
		} else if (access.access.node_type === "access_func") {
			// Method call like `s.length()` / `b.size()` — treat the method as
			// a property for bounds purposes (its return value IS the length).
			const target = expr_to_string(access.target, status);
			const method = (access.access as any).name;
			if (target && ["length", "size", "count", "cap"].includes(method)) {
				const path = `${target}.${method}`;
				return status ? canonicalize_length_path(path, status) : path;
			}
		}
	}
	return undefined;
}

/**
 * Rewrite a `<base>.<field>` path through the assumed parallel-length
 * equalities (`a.length == b.length` param contracts) to a canonical
 * representative, so a bound phrased against either container's length
 * (`i < xs.length`) verifies a constraint on the other (`hash.length`).
 * Each equation's `a` side is the representative; following `b → a` edges
 * to a fixed point makes the rewrite idempotent and confluent for chains
 * (a==b, b==c all canonicalize to the chain head). Only touches paths whose
 * field has a recorded equation.
 */
function canonicalize_length_path(path: string, status: CheckStatus): string {
	const eqs = status.equal_lengths;
	if (!eqs?.length) return path;
	const m = /^(\w+)\.(length|count|size|cap)$/.exec(path);
	if (!m) return path;
	const field = m[2];
	let base = m[1];
	for (let step = 0; step < eqs.length; step++) {
		const eq = eqs.find((e) => e.field === field && (e.a === base || e.b === base));
		if (!eq || eq.a === base) break;
		base = eq.a;
	}
	return `${base}.${field}`;
}

/**
 * Remove `X.<f> == Y.<f>` clauses (same container-size field on two params,
 * one of them `param_name`) from a parameter constraint, recording each as an
 * ASSUMED parallel-length equality on `status.equal_lengths`. Such a clause
 * relates two runtime lengths, which the verifier can never prove at a call
 * site — instead it is trusted there (stripped from the contract) and made
 * available to the body's bounds machinery via expr_to_string
 * canonicalization. Returns the rewritten constraint, or undefined when
 * everything was stripped. Nodes are only rebuilt when something changed.
 */
export function strip_length_equalities(
	constraint: BaseNode | undefined,
	param_name: string,
	status: CheckStatus,
): BaseNode | undefined {
	if (!constraint) return undefined;
	if (constraint.node_type !== "op") return constraint;
	const op = constraint as OperationNode;
	if (op.op === "&&") {
		const left = strip_length_equalities(op.left_value, param_name, status);
		const right = strip_length_equalities(op.right_value, param_name, status);
		if (left && right) {
			if (left === op.left_value && right === op.right_value) return constraint;
			return new OperationNode(op.start, "&&", left, right, op.type);
		}
		return left ?? right;
	}
	if (op.op !== "==") return constraint;
	// Both sides must be `<param>.<size field>` accesses over existing values.
	const extract = (side: BaseNode): { base: string; field: string } | undefined => {
		if (side.node_type !== "access") return undefined;
		const access = side as AccessNode;
		let field: string | undefined;
		if (access.access.node_type === "access_field") {
			field = (access.access as AccessFieldNode).name;
		} else if (access.access.node_type === "access_func") {
			field = (access.access as any).name;
		}
		if (!field || !NON_NEGATIVE_FIELDS.has(field)) return undefined;
		if (access.target.node_type !== "value") return undefined;
		const base = (access.target as ValueNode).value;
		// The param's own name isn't in `values` yet (constraints are checked
		// before the param is pushed), so accept it implicitly; the OTHER side
		// must already exist.
		if (base !== param_name && !status.values.some((v) => v.name === base)) return undefined;
		return { base, field };
	};
	const lhs = extract(op.left_value);
	const rhs = extract(op.right_value);
	if (!lhs || !rhs || lhs.field !== rhs.field) return constraint;
	if (lhs.base === rhs.base) return constraint;

	if (!status.equal_lengths) status.equal_lengths = [];
	const other = lhs.base;
	const paired = rhs.base;
	const duplicate = status.equal_lengths.some(
		(e) =>
			e.field === lhs.field &&
			((e.a === other && e.b === paired) || (e.a === paired && e.b === other)),
	);
	if (!duplicate) {
		// `a` is the canonical side; `param_name` (when it is one endpoint)
		// canonicalizes onto the other container's length.
		status.equal_lengths.push({ a: other, b: paired, field: lhs.field });
	}
	return undefined;
}

/**
 * Registration-time variant of strip_length_equalities: removes
 * `<container>.<size> == <container>.<size>` conjuncts from a parameter
 * constraint and returns them alongside the remaining constraint. Used when a
 * function signature is REGISTERED — before any call site can observe it — so
 * a forward-referenced callee never hands its caller a clause no call site
 * could prove (declaration order must not matter). Bases are validated
 * against `known_names` (the function's own parameters) instead of
 * status.values, because at registration time nothing has been pushed into
 * any scope yet. Does NOT touch status.equal_lengths: the extracted
 * equalities are returned for the callee's own param check to seed.
 */
export function extract_length_equalities_at_registration(
	constraint: BaseNode | undefined,
	param_name: string,
	known_names: Set<string>,
): { constraint: BaseNode | undefined; equalities: { a: string; b: string; field: string }[] } {
	const equalities: { a: string; b: string; field: string }[] = [];
	if (!constraint) return { constraint, equalities };
	const walk = (node: BaseNode): BaseNode | undefined => {
		if (node.node_type !== "op") return node;
		const op = node as OperationNode;
		if (op.op === "&&") {
			const left = walk(op.left_value);
			const right = walk(op.right_value);
			if (left && right) {
				if (left === op.left_value && right === op.right_value) return node;
				return new OperationNode(op.start, "&&", left, right, op.type);
			}
			return left ?? right;
		}
		if (op.op !== "==") return node;
		const extract = (side: BaseNode): { base: string; field: string } | undefined => {
			if (side.node_type !== "access") return undefined;
			const access = side as AccessNode;
			let field: string | undefined;
			if (access.access.node_type === "access_field") {
				field = (access.access as AccessFieldNode).name;
			} else if (access.access.node_type === "access_func") {
				field = (access.access as unknown as { name?: string }).name;
			}
			if (!field || !NON_NEGATIVE_FIELDS.has(field)) return undefined;
			if (access.target.node_type !== "value") return undefined;
			return { base: (access.target as ValueNode).value, field };
		};
		const lhs = extract(op.left_value);
		const rhs = extract(op.right_value);
		if (!lhs || !rhs || lhs.field !== rhs.field) return node;
		if (lhs.base === rhs.base) return node;
		// Both endpoints must be parameters of THIS function (the param itself
		// or a sibling — on either side; order must not matter).
		for (const base of [lhs.base, rhs.base]) {
			if (base !== param_name && !known_names.has(base)) return node;
		}
		equalities.push({ a: lhs.base, b: rhs.base, field: lhs.field });
		return undefined;
	};
	return { constraint: walk(constraint), equalities };
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

	// Arithmetic-left comparisons (e.g. `i + 5 < len`) are handled by
	// apply_shifted_bound, which shifts the bound onto the bare variable `i`.
	// Returning undefined here lets apply_bounds fall through to that path.
	if (op.left_value.node_type === "op") {
		const lop = op.left_value as OperationNode;
		if (lop.op === "+" || lop.op === "-") {
			const is_const = (n: BaseNode) =>
				n.node_type === "value" && /^[+-]?\d+$/.test((n as ValueNode).value);
			if (is_const(lop.left_value) || is_const(lop.right_value)) return undefined;
		}
	}

	// Try var/access OP expr (e.g. j < list.length, self.length < self.items.cap)
	if (op.left_value.node_type === "value" || op.left_value.node_type === "access") {
		const var_name =
			op.left_value.node_type === "value"
				? (op.left_value as ValueNode).value
				: expr_to_string(op.left_value, status);
		const expr = expr_to_string(op.right_value, status);
		if (var_name && expr) return { var_name, op: op.op, expr };
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
 * Extract a `target.length == literal` (or `literal == target.length`)
 * equality guard. Returns the base variable name and the literal value, so
 * the caller can record it as a flow-sensitive `known_length` for
 * `numeric_interval` to consult. Returns undefined for anything else.
 */
function extract_equality_length(
	condition: BaseNode,
	status: CheckStatus,
): { target: string; value: number } | undefined {
	if (condition.node_type !== "op") return undefined;
	const op = condition as OperationNode;
	if (op.op !== "==") return undefined;

	for (const [left, right] of [
		[op.left_value, op.right_value],
		[op.right_value, op.left_value],
	]) {
		if (left.node_type !== "access") continue;
		const access = left as AccessNode;
		if (access.access.node_type !== "access_field") continue;
		if ((access.access as AccessFieldNode).name !== "length") continue;
		if (access.target.node_type !== "value") continue;
		const target = (access.target as ValueNode).value;
		if (right.node_type !== "value") continue;
		if (!/^[+-]?\d+$/.test((right as ValueNode).value)) continue;
		const value = parseInt((right as ValueNode).value, 10);
		// Only record when the base variable actually exists — otherwise we'd
		// invent facts about unknown identifiers.
		if (!status.values.some((v) => v.name === target)) continue;
		return { target, value };
	}
	return undefined;
}

/**
 * Apply extracted bounds to the status's values.
 * Call this when entering an if/while body where the condition establishes bounds.
 */
export function apply_bounds(condition: BaseNode, status: CheckStatus, is_loop = false) {
	// Handle && conditions (e.g. j >= 0 && j < list.length)
	if (condition.node_type === "op") {
		const op = condition as OperationNode;
		if (op.op === "&&") {
			apply_bounds(op.left_value, status, is_loop);
			apply_bounds(op.right_value, status, is_loop);
			return;
		}
	}

	// Equality guard: `arr.length == N` (or `N == arr.length`) tells us the
	// array/string's length is exactly N for the duration of the body. Record
	// it on the StackValue so `numeric_interval` can resolve `arr.length` and
	// prove e.g. `i < arr.length` for literal `i`. (Loops can't establish this
	// — a `while arr.length == 3` would either run forever or never.)
	if (!is_loop) {
		const eq = extract_equality_length(condition, status);
		if (eq) {
			const decl = status.values.findLast((v) => v.name === eq.target);
			if (decl) decl.known_length = eq.value;
			return;
		}
	}

	const bound = extract_bound(condition, status);
	if (!bound) {
		apply_shifted_bound(condition, status, is_loop);
		return;
	}

	// For dotted names like "self.length", the StackValue is stored under
	// the base name "self", but bounds are keyed by the full dotted path.
	let var_decl = status.values.findLast((v) => v.name === bound.var_name);
	if (!var_decl && bound.var_name.includes(".")) {
		const base = bound.var_name.split(".")[0];
		var_decl = status.values.findLast((v) => v.name === base);
	}
	if (!var_decl) return;

	// Dotted-path precision: when the bounded name is a field path on the
	// base variable (e.g. "p.a" from a field-referencing out-contract
	// `out.a < xs.length` substituted onto the binding `p`), record the
	// bound under the full path in `path_bounds` too. The shared arrays
	// below cannot distinguish WHICH field of `p` a bound constrains; an
	// access argument like `p.a` reads the path entry so it carries exactly
	// the bounds proven for that path.
	let path_entry: import("../StackValue.ts").PathBounds | undefined;
	if (bound.var_name.includes(".") && bound.var_name !== var_decl.name) {
		if (!var_decl.path_bounds) var_decl.path_bounds = new Map();
		path_entry = var_decl.path_bounds.get(bound.var_name);
		if (!path_entry) {
			path_entry = {};
			var_decl.path_bounds.set(bound.var_name, path_entry);
		}
	}
	const push_unique = (arr: string[] | undefined, expr: string): string[] => {
		const out = arr ?? [];
		if (!out.includes(expr)) out.push(expr);
		return out;
	};

	if (bound.op === "<" || bound.op === "<=") {
		const inclusive = bound.op === "<=";
		if (!var_decl.upper_bound_exprs) var_decl.upper_bound_exprs = [];
		if (!var_decl.upper_bound_inclusive_exprs) var_decl.upper_bound_inclusive_exprs = [];
		if (inclusive) {
			var_decl.upper_bound_inclusive_exprs = push_unique(
				var_decl.upper_bound_inclusive_exprs,
				bound.expr,
			);
			if (path_entry) {
				path_entry.upper_inclusive = push_unique(path_entry.upper_inclusive, bound.expr);
			}
		} else {
			var_decl.upper_bound_exprs = push_unique(var_decl.upper_bound_exprs, bound.expr);
			if (path_entry) {
				path_entry.upper = push_unique(path_entry.upper, bound.expr);
			}
		}
		// Backwards compat
		var_decl.upper_bound_expr = bound.expr;
		// Numeric upper bound for the verifier's arithmetic path. A strict
		// `j < E` means j's max (exclusive) is E; an inclusive `j <= E`
		// means j's max is E + 1.
		const num = numeric_interval(string_to_node(bound.expr), status);
		if (num) {
			// For a loop body the condition is re-checked every iteration and
			// the variable is reassigned inside, so the bound ESTABLISHES the
			// variable's range for the body (overwrite). For an `if` guard the
			// bound NARROWS (take the tightest upper).
			const hi = bound.op === "<=" ? num.upper : num.lower;
			if (is_loop) {
				var_decl.range_upper = hi;
			} else {
				if (var_decl.range_upper === undefined || hi < var_decl.range_upper)
					var_decl.range_upper = hi;
			}
			if (path_entry) {
				if (is_loop) {
					path_entry.range_upper = hi;
				} else if (path_entry.range_upper === undefined || hi < path_entry.range_upper) {
					path_entry.range_upper = hi;
				}
			}
		}
	} else if (bound.op === ">" || bound.op === ">=") {
		const inclusive = bound.op === ">=";
		if (!var_decl.lower_bound_exprs) var_decl.lower_bound_exprs = [];
		if (!var_decl.lower_bound_inclusive_exprs) var_decl.lower_bound_inclusive_exprs = [];
		if (inclusive) {
			var_decl.lower_bound_inclusive_exprs = push_unique(
				var_decl.lower_bound_inclusive_exprs,
				bound.expr,
			);
			if (path_entry) {
				path_entry.lower_inclusive = push_unique(path_entry.lower_inclusive, bound.expr);
			}
		} else {
			var_decl.lower_bound_exprs = push_unique(var_decl.lower_bound_exprs, bound.expr);
			if (path_entry) {
				path_entry.lower = push_unique(path_entry.lower, bound.expr);
			}
		}
		var_decl.lower_bound_expr = bound.expr;
		// Numeric lower bound: `j > E` means j's min (inclusive) is E + 1;
		// `j >= E` means j's min is E.
		const num = numeric_interval(string_to_node(bound.expr), status);
		if (num) {
			const lo = bound.op === ">=" ? num.lower : num.upper;
			if (var_decl.range_lower === undefined || lo > var_decl.range_lower)
				var_decl.range_lower = lo;
			if (path_entry && (path_entry.range_lower === undefined || lo > path_entry.range_lower))
				path_entry.range_lower = lo;
		}
	}

	// Inverse bound: a binary comparison also constrains the OTHER operand.
	// For `X < Y` with X having a known numeric lower bound `xlo`, we know
	// `Y > X >= xlo`, so `Y >= xlo + 1` (integers). This lets a loop like
	// `while find < order_len` (with `find = 0`) establish `order_len >= 1`
	// inside the body, so `arr.at(order_len - 1)` verifies.
	apply_inverse_numeric_bound(bound, var_decl, status);
}

/**
 * Propagate a comparison's bound onto the OTHER operand's numeric range.
 * E.g. for `find < order_len` with `find.range_lower = 0`, set
 * `order_len.range_lower = 1`. Only handles the simple case where the
 * other side is a bare variable (not an arbitrary expression).
 */
function apply_inverse_numeric_bound(
	bound: { var_name: string; op: string; expr: string } | undefined,
	var_decl: StackValueLike | undefined,
	status: CheckStatus,
) {
	if (!bound || !var_decl) return;
	// Other side must be a bare variable name (e.g. "order_len", not "arr.length").
	const m = /^(\w+)$/.exec(bound.expr);
	if (!m) return;
	const other_name = m[1];
	const other_decl = status.values.findLast((v) => v.name === other_name);
	if (!other_decl) return;

	if (bound.op === "<" || bound.op === "<=") {
		// `X < Y` ⟹ `Y > X` ⟹ `Y >= X.range_lower + 1` (strict)
		// `X <= Y` ⟹ `Y >= X` ⟹ `Y >= X.range_lower` (inclusive)
		if (var_decl.range_lower !== undefined) {
			const new_lo = bound.op === "<" ? var_decl.range_lower + 1 : var_decl.range_lower;
			if (other_decl.range_lower === undefined || new_lo > other_decl.range_lower) {
				other_decl.range_lower = new_lo;
			}
		}
	} else if (bound.op === ">" || bound.op === ">=") {
		// `X > Y` ⟹ `Y < X` ⟹ `Y < X.range_upper` (strict, exclusive)
		// `X >= Y` ⟹ `Y <= X` ⟹ `Y <= X.range_upper - 1` ⟹ `Y.range_upper = X.range_upper` (exclusive)
		if (var_decl.range_upper !== undefined) {
			const new_hi = bound.op === ">" ? var_decl.range_upper : var_decl.range_upper + 1;
			if (other_decl.range_upper === undefined || new_hi < other_decl.range_upper) {
				other_decl.range_upper = new_hi;
			}
		}
	}
}

type StackValueLike = {
	range_lower?: number;
	range_upper?: number;
};

/**
 * Reconstruct a node from a canonical bound string (e.g. "list.length",
 * "n", "self.items.cap") so numeric_interval can resolve it. Handles a bare
 * variable name and a dotted field access.
 */
function string_to_node(expr: string): BaseNode {
	const parts = expr.split(".");
	let node: BaseNode = new ValueNode(0, parts[0]);
	for (let i = 1; i < parts.length; i++) {
		node = new AccessNode(0, node, new AccessFieldNode(0, parts[i]));
	}
	return node;
}

/**
 * Union of two numeric lower bounds: the LOOSEST (smallest) `>=` value that
 * holds across two branches. Returns undefined if either side is undefined
 * (one branch cleared the bound via reassignment) — losing the bound is the
 * sound over-approximation. Used by if/switch reconciliation.
 */
export function union_min(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined || b === undefined) return undefined;
	return Math.min(a, b);
}

/**
 * Union of two numeric upper bounds: the LOOSEST (largest) `<` value that
 * holds across two branches. undefined if either side is undefined.
 */
export function union_max(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined || b === undefined) return undefined;
	return Math.max(a, b);
}

/**
 * Intersection of two bound-expression lists: only expressions that hold in
 * BOTH branches survive the merge. Returns undefined when either side is
 * undefined (one branch cleared its bounds via reassignment).
 */
export function intersect_strs(
	a: string[] | undefined,
	b: string[] | undefined,
): string[] | undefined {
	if (a === undefined || b === undefined) return undefined;
	const out: string[] = [];
	for (const e of a) {
		if (b.includes(e)) out.push(e);
	}
	return out;
}

/**
 * Handle a comparison whose LEFT operand is `v ± c` (e.g. `i + 5 < textlen`).
 * Shifts the bound onto the bare variable `v`: `i + 5 < E` ⇒ `i < E - 5`, so
 * `v`'s numeric upper bound becomes `E - c`. This lets guards like
 * `if i + 5 < len { arr.at(i + 1) }` verify. Sets both the numeric range and
 * the string bound expr (shifted) so the flow path also matches.
 */
export function apply_shifted_bound(condition: BaseNode, status: CheckStatus, is_loop = false) {
	if (condition.node_type !== "op") return;
	const op = condition as OperationNode;
	if (op.op !== "<" && op.op !== "<=" && op.op !== ">" && op.op !== ">=") return;
	let var_name: string | undefined;
	let offset = 0;
	const left = op.left_value;
	if (left.node_type === "op") {
		const lop = left as OperationNode;
		if (lop.op === "+" || lop.op === "-") {
			if (
				lop.left_value.node_type === "value" &&
				/^[+-]?\d+$/.test((lop.left_value as ValueNode).value)
			) {
				offset = parseInt((lop.left_value as ValueNode).value, 10);
				if (lop.op === "-") offset = -offset;
				if (lop.right_value.node_type === "value") var_name = (lop.right_value as ValueNode).value;
			} else if (
				lop.right_value.node_type === "value" &&
				/^[+-]?\d+$/.test((lop.right_value as ValueNode).value)
			) {
				offset = parseInt((lop.right_value as ValueNode).value, 10);
				if (lop.op === "-") offset = -offset;
				if (lop.left_value.node_type === "value") var_name = (lop.left_value as ValueNode).value;
			}
		}
	}
	if (!var_name) return;
	const var_decl = status.values.findLast((v) => v.name === var_name);
	if (!var_decl) return;

	// Numeric bound: shift the right side by -offset.
	const rnum = numeric_interval(op.right_value, status);
	if (rnum) {
		if (op.op === "<" || op.op === "<=") {
			const hi = op.op === "<=" ? rnum.lower - offset + 1 : rnum.lower - offset;
			// Loop body: establish (overwrite) the upper bound; `if` guard: narrow.
			if (is_loop) {
				var_decl.range_upper = hi;
			} else {
				if (var_decl.range_upper === undefined || hi < var_decl.range_upper)
					var_decl.range_upper = hi;
			}
		} else if (op.op === ">" || op.op === ">=") {
			const lo = op.op === ">=" ? rnum.lower - offset : rnum.lower - offset + 1;
			if (var_decl.range_lower === undefined || lo > var_decl.range_lower)
				var_decl.range_lower = lo;
		}
	}

	// String bound expr (shifted) so the flow path also matches accesses that
	// reference the same `E` directly.
	const expr_str = expr_to_string(op.right_value, status);
	if (expr_str) {
		const shifted = `${expr_str} ${offset >= 0 ? "-" : "+"} ${Math.abs(offset)}`;
		if (op.op === "<" || op.op === "<=") {
			if (!var_decl.upper_bound_exprs) var_decl.upper_bound_exprs = [];
			if (!var_decl.upper_bound_exprs.includes(shifted)) var_decl.upper_bound_exprs.push(shifted);
			var_decl.upper_bound_expr = shifted;
		} else {
			if (!var_decl.lower_bound_exprs) var_decl.lower_bound_exprs = [];
			if (!var_decl.lower_bound_exprs.includes(shifted)) var_decl.lower_bound_exprs.push(shifted);
			var_decl.lower_bound_expr = shifted;
		}
	}
}

/**
 * Clear flow-sensitive bounds on a variable (call on reassignment).
 */
export function clear_bounds(name: string, status: CheckStatus) {
	const decl = status.values.findLast((v) => v.name === name);
	if (decl) {
		decl.upper_bound_exprs = undefined;
		decl.lower_bound_exprs = undefined;
		decl.upper_bound_inclusive_exprs = undefined;
		decl.lower_bound_inclusive_exprs = undefined;
		decl.upper_bound_expr = undefined;
		decl.lower_bound_expr = undefined;
		decl.path_bounds = undefined;
	}
}

/**
 * Substitute `out` and parameter names in a return-constraint expression with
 * caller-side expressions. Used to translate a function's `out TYPE: contract`
 * into bounds on the caller's LHS variable.
 *
 * Returns a new OperationNode tree (shallow clone where needed) with:
 *   - ValueNode("out") replaced with ValueNode(lhs_name)
 *   - ValueNode(param_name) replaced with the matching arg expression
 */
export function substitute_constraint(
	node: BaseNode,
	lhs_name: string,
	param_to_arg: Map<string, BaseNode>,
	visited: Set<BaseNode> = new Set(),
): BaseNode {
	if (visited.has(node)) return node;
	visited.add(node);

	if (node.node_type === "value") {
		const vn = node as ValueNode;
		if (vn.value === "out") {
			return new ValueNode(vn.start, lhs_name, vn.type);
		}
		const arg = param_to_arg.get(vn.value);
		if (arg) return arg;
		return node;
	}

	if (node.node_type === "op") {
		const op = node as OperationNode;
		return new OperationNode(
			op.start,
			op.op,
			substitute_constraint(op.left_value, lhs_name, param_to_arg, visited),
			substitute_constraint(op.right_value, lhs_name, param_to_arg, visited),
			op.type,
		);
	}

	if (node.node_type === "access") {
		const access = node as AccessNode;
		// Recurse into the target so `self.count` has its `self` replaced with
		// the caller's receiver. The accessed field name is left as-is.
		return new AccessNode(
			access.start,
			substitute_constraint(access.target, lhs_name, param_to_arg, visited),
			access.access,
		);
	}

	return node;
}

/**
 * Bounds collected from a call node's (substituted) return contract — the
 * same decoration the nested-call path reads (see collect_return_bounds).
 */
export interface ReturnBounds {
	upper: string[];
	lower: string[];
	upper_inclusive: string[];
	lower_inclusive: string[];
}

/** Extract `return_bounds` from a value node that is a call (or wraps one). */
export function call_return_bounds(value: BaseNode): ReturnBounds | undefined {
	if (!value) return undefined;
	if (value.node_type === "func_call" || value.node_type === "access_func") {
		return (value as any).return_bounds as ReturnBounds | undefined;
	}
	if (value.node_type === "access" && (value as AccessNode).access.node_type === "access_func") {
		return ((value as AccessNode).access as any).return_bounds as ReturnBounds | undefined;
	}
	return undefined;
}

/**
 * Transfer a call's return-contract bounds onto the variable the call result
 * is bound to (`const int m = mid(xs)` / `m = mid(xs)`). Without this, only
 * the nested form `xs.at(mid(xs))` carried the contract (via the call node's
 * `return_bounds` decoration); binding to a variable dropped it and forced
 * unreadable nesting. Uses the same funneled semantics as the nested path
 * (collect_return_bounds: `<=` lands in the strict `upper` array), so both
 * forms verify identically.
 */
export function apply_return_bounds_to_var(
	name: string,
	rb: ReturnBounds | undefined,
	status: CheckStatus,
) {
	if (!rb) return;
	const decl = status.values.findLast((v) => v.name === name);
	if (!decl) return;
	const push = (arr: string[] | undefined, add: string[]) =>
		arr ? (arr.push(...add.filter((e) => !arr.includes(e))), arr) : add.slice();
	if (rb.upper.length) decl.upper_bound_exprs = push(decl.upper_bound_exprs, rb.upper);
	if (rb.lower.length) decl.lower_bound_exprs = push(decl.lower_bound_exprs, rb.lower);
	if (rb.upper_inclusive.length)
		decl.upper_bound_inclusive_exprs = push(decl.upper_bound_inclusive_exprs, rb.upper_inclusive);
	if (rb.lower_inclusive.length)
		decl.lower_bound_inclusive_exprs = push(decl.lower_bound_inclusive_exprs, rb.lower_inclusive);
}

/**
 * Build an expression node tree from a dotted path string (e.g. "list",
 * "self.items") for use in return-contract substitution. Used to map `self`
 * onto the caller's receiver path.
 */
export function path_to_node(path: string): BaseNode {
	const parts = path.split(".");
	let node: BaseNode = new ValueNode(0, parts[0]);
	for (let i = 1; i < parts.length; i++) {
		node = new AccessNode(0, node, new AccessFieldNode(0, parts[i]));
	}
	return node;
}

/**
 * Collect the upper/lower bound expressions from a (substituted) return
 * contract, walking `&&`-combined comparisons. The left operand is assumed to
 * be the return value (`out`); only the comparison operator and the right-hand
 * expression are extracted. Used to propagate a call's return-contract bounds
 * onto the call node so an enclosing call can verify its parameter constraint
 * against the returned value (e.g. `g.at(g.edge_target(e))`).
 *
 * Strict inequalities (`<`, `>`) and their inclusive cousins (`<=`, `>=`) are
 * both funneled into the strict `upper`/`lower` arrays (matching pre-existing
 * behavior). Equality (`==`) is exact, so it is reported on the separate
 * `upper_inclusive`/`lower_inclusive` arrays instead — `out.X == expr` means the
 * result is both `<= expr` and `>= expr`, and only the inclusive bound arrays
 * can carry that without collapsing to a contradiction.
 * (`extract_bound` only covers `<`/`<=`/`>`/`>=`, so `==` is handled here.)
 */
export function collect_return_bounds(
	node: BaseNode,
	status?: CheckStatus,
): {
	upper: string[];
	lower: string[];
	upper_inclusive: string[];
	lower_inclusive: string[];
} {
	const upper: string[] = [];
	const lower: string[] = [];
	const upper_inclusive: string[] = [];
	const lower_inclusive: string[] = [];
	function walk(n: BaseNode) {
		if (n.node_type !== "op") return;
		const op = n as OperationNode;
		if (op.op === "&&") {
			walk(op.left_value);
			walk(op.right_value);
			return;
		}
		if (op.op === "==") {
			// Symmetric: prefer the left operand as the return-value side
			// (the `out` convention), fall back to the right.
			let expr: string | undefined;
			if (op.left_value.node_type === "value" || op.left_value.node_type === "access") {
				expr = expr_to_string(op.right_value, status);
			} else if (op.right_value.node_type === "value" || op.right_value.node_type === "access") {
				expr = expr_to_string(op.left_value, status);
			}
			if (expr) {
				if (!upper_inclusive.includes(expr)) upper_inclusive.push(expr);
				if (!lower_inclusive.includes(expr)) lower_inclusive.push(expr);
			}
			return;
		}
		const bound = extract_bound(n, status);
		if (bound) {
			if (bound.op === "<" || bound.op === "<=") {
				if (!upper.includes(bound.expr)) upper.push(bound.expr);
			} else if (bound.op === ">" || bound.op === ">=") {
				if (!lower.includes(bound.expr)) lower.push(bound.expr);
			}
		}
	}
	walk(node);
	return { upper, lower, upper_inclusive, lower_inclusive };
}

/**
 * Extract a compile-time length from a return contract clause of the form
 * `out.length == <int literal>` (after substitution, e.g. `_return.length == 5`).
 * Walks `&&`-combined contracts. Returns the literal as a string, or undefined.
 * This powers the BUILD path: an `Array.with(elem, 5)` result needs its type to
 * carry `.length = 5` so the inline `to_string` paths (which unroll a literal
 * number of elements) fire instead of emitting a call to a never-emitted
 * `Array_T_to_string`. The bounds-check half is handled separately by
 * `known_length`; this is purely for codegen.
 */
export function collect_return_length(node: BaseNode): string | undefined {
	let result: string | undefined;
	function walk(n: BaseNode) {
		if (result !== undefined) return;
		if (n.node_type !== "op") return;
		const op = n as OperationNode;
		if (op.op === "&&") {
			walk(op.left_value);
			walk(op.right_value);
			return;
		}
		if (op.op !== "==") return;
		for (const [len_side, val_side] of [
			[op.left_value, op.right_value],
			[op.right_value, op.left_value],
		]) {
			if (len_side.node_type !== "access") continue;
			const access = len_side as AccessNode;
			if (access.access.node_type !== "access_field") continue;
			if ((access.access as AccessFieldNode).name !== "length") continue;
			if (val_side.node_type !== "value") continue;
			if (!/^[+-]?\d+$/.test((val_side as ValueNode).value)) continue;
			result = (val_side as ValueNode).value;
			return;
		}
	}
	walk(node);
	return result;
}

/**
 * Track flow-sensitive knowledge gained from a declaration/assignment.
 * Currently handles:
 *   - `var int x = Y.field`     → x becomes an alias for "Y.field"
 *   - `var int x = a % b`        → x.range_lower = 0, x.range_upper = b
 *                                  (when b is a known positive constant)
 *   - `var int x = N`            → x.range_lower = N, x.range_upper = N + 1
 *                                  (the value IS N, until reassigned)
 *
 * Call this AFTER the variable has been pushed to status.values.
 *
 * `reassigned_self_bounds` is an optional snapshot of the LHS variable's
 * bounds BEFORE they were cleared by `check_assignment_node`. It's used
 * when the RHS is a shifted bound like `i = i + N`: the base operand (`i`)
 * is the same as the LHS, so by the time this runs, the lookup of `base_decl`
 * in `status.values` would find an already-cleared StackValue. The snapshot
 * lets case (4) below see the original bounds (e.g. `i >= 0` ⇒ new `i >= N`).
 */
export function track_assignment_bounds(
	var_name: string,
	value: BaseNode,
	status: CheckStatus,
	reassigned_self_bounds?: BoundsSnapshot,
) {
	const decl = status.values.findLast((v) => v.name === var_name);
	if (!decl) return;

	// 1) Field-access alias: `var int cap = self.keys.cap` → cap alias_of "self.keys.cap"
	//    Lets bounds on `cap` flow through to verifications involving `self.keys.cap".
	//    For non-negative fields (length/cap/count/size), also record explicit
	//    inclusive bounds (`cap <= self.keys.cap`, `cap >= self.keys.cap`) and a
	//    `range_lower = 0`. The alias alone is lossy: an if-else reconciliation
	//    that copies the if-branch's state can lose `e <= text.length` for a
	//    clamp like `if e > text.length { e = text.length }` when the negated
	//    bound is also recorded on the parent — pinning both sides here makes
	//    the bound survive the merge and lets `e >= 0` verify via the
	//    non-negative access path. It also lets `n >= m` verify when n aliases
	//    a non-negative access and m has range [0, 1) (e.g. `end >= start`
	//    where end aliases text.length and start is `var int s = 0`).
	if (value.node_type === "access") {
		const field_str = expr_to_string(value, status);
		if (field_str) {
			decl.alias_of = field_str;
			const last = field_str.split(".").at(-1);
			if (last && NON_NEGATIVE_FIELDS.has(last)) {
				if (!decl.upper_bound_inclusive_exprs) decl.upper_bound_inclusive_exprs = [];
				if (!decl.upper_bound_inclusive_exprs.includes(field_str)) {
					decl.upper_bound_inclusive_exprs.push(field_str);
				}
				if (!decl.lower_bound_inclusive_exprs) decl.lower_bound_inclusive_exprs = [];
				if (!decl.lower_bound_inclusive_exprs.includes(field_str)) {
					decl.lower_bound_inclusive_exprs.push(field_str);
				}
				decl.upper_bound_expr = field_str;
				decl.lower_bound_expr = field_str;
				decl.range_lower = 0;
			}
			return;
		}
	}

	// 2) Modulo range: `var int idx = a % b` → 0 <= idx < b
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

	// 3) Literal initialization: `var int i = 5` → range [5, 6), so the value
	//    is provably 5. Cleared on reassignment by check_assignment_node.
	const lit = int_literal(value);
	if (lit !== undefined) {
		decl.range_lower = lit;
		decl.range_upper = lit + 1;
	}

	// 4) Shifted bound: `var int j = i + 1` / `j - 2` / `2 + k` where the
	//    operand is a known-bounded variable. Shift the operand's proven bounds
	//    by the constant offset so `j >= 0` (and the upper bound) flow through.
	if (value.node_type === "op") {
		const op = value as OperationNode;
		if (op.op === "+" || op.op === "-") {
			const left = op.left_value;
			const right = op.right_value;
			let base: BaseNode | undefined;
			let offset = 0;
			if (left.node_type === "value" && /^[+-]?\d+$/.test((left as ValueNode).value)) {
				offset = parseInt((left as ValueNode).value, 10);
				base = right;
			} else if (right.node_type === "value" && /^[+-]?\d+$/.test((right as ValueNode).value)) {
				offset = parseInt((right as ValueNode).value, 10);
				base = left;
				if (op.op === "-") offset = -offset;
			}
			if (base?.node_type === "value" && offset !== 0) {
				const base_name = (base as ValueNode).value;
				// When the LHS is being reassigned to `LHS + N`, the base operand
				// IS the LHS — but its bounds have already been cleared by the
				// time we get here. Use the snapshot captured before clearing.
				const base_decl =
					base_name === var_name && reassigned_self_bounds
						? reassigned_self_bounds
						: status.values.findLast((v) => v.name === base_name);
				if (base_decl) {
					const shift = (exprs?: string[]) => {
						const out: string[] = [];
						for (const e of exprs ?? [])
							out.push(`${e} ${offset >= 0 ? "+" : "-"} ${Math.abs(offset)}`);
						return out;
					};
					decl.lower_bound_exprs = shift(base_decl.lower_bound_exprs);
					decl.upper_bound_exprs = shift(base_decl.upper_bound_exprs);
					decl.lower_bound_inclusive_exprs = shift(base_decl.lower_bound_inclusive_exprs);
					decl.upper_bound_inclusive_exprs = shift(base_decl.upper_bound_inclusive_exprs);
					if (base_decl.range_lower !== undefined)
						decl.range_lower = base_decl.range_lower + offset;
					if (base_decl.range_upper !== undefined)
						decl.range_upper = base_decl.range_upper + offset;
				}
			}
		}
	}

	// 5) Variable-to-variable: `var int x = y` / `x = y` — copy y's
	//    flow-sensitive bounds onto x. This lets `if y > 0 { x = y }`
	//    propagate y's lower bound onto x so subsequent uses of x carry
	//    the bound (e.g. proving `x >= 0` for `Array.with(0, x)`).
	if (value.node_type === "value") {
		const vn = value as ValueNode;
		if (!/^[+-]?\d+$/.test(vn.value)) {
			const src = status.values.findLast((v) => v.name === vn.value);
			if (src) {
				if (decl.range_lower === undefined && src.range_lower !== undefined)
					decl.range_lower = src.range_lower;
				if (decl.range_upper === undefined && src.range_upper !== undefined)
					decl.range_upper = src.range_upper;
				if (!decl.lower_bound_exprs?.length && src.lower_bound_exprs?.length)
					decl.lower_bound_exprs = src.lower_bound_exprs.slice();
				if (!decl.upper_bound_exprs?.length && src.upper_bound_exprs?.length)
					decl.upper_bound_exprs = src.upper_bound_exprs.slice();
				if (!decl.lower_bound_inclusive_exprs?.length && src.lower_bound_inclusive_exprs?.length)
					decl.lower_bound_inclusive_exprs = src.lower_bound_inclusive_exprs.slice();
				if (!decl.upper_bound_inclusive_exprs?.length && src.upper_bound_inclusive_exprs?.length)
					decl.upper_bound_inclusive_exprs = src.upper_bound_inclusive_exprs.slice();
				if (!decl.lower_bound_expr && src.lower_bound_expr)
					decl.lower_bound_expr = src.lower_bound_expr;
				if (!decl.upper_bound_expr && src.upper_bound_expr)
					decl.upper_bound_expr = src.upper_bound_expr;
			}
		}
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
 * Resolve a bound expression to a numeric interval {lower, upper} (upper is
 * EXCLUSIVE) when it can be determined statically. Handles literals, const
 * variables, array lengths (`arr.length` for fixed-size arrays), and simple
 * arithmetic (`a + c`, `a - c`) where `a` resolves numerically. Returns
 * undefined when the value isn't known. This powers the numeric half of the
 * bounds verifier so that offsets like `arr.at(i - 1)` can be proven safe.
 */
export function numeric_interval(
	node: BaseNode | undefined,
	status: CheckStatus,
): { lower: number; upper: number } | undefined {
	if (!node) return undefined;
	if (node.node_type === "value") {
		const vn = node as ValueNode;
		if (/^[+-]?\d+$/.test(vn.value))
			return { lower: parseInt(vn.value, 10), upper: parseInt(vn.value, 10) + 1 };
		const decl = status.values.findLast((v) => v.name === vn.value);
		if (decl?.const_value !== undefined && typeof decl.const_value === "number") {
			return { lower: decl.const_value, upper: decl.const_value + 1 };
		}
		// a variable that itself has a known numeric range
		if (decl?.range_lower !== undefined && decl.range_upper !== undefined) {
			return { lower: decl.range_lower, upper: decl.range_upper };
		}
		// a variable aliasing `arr.length` / `arr.length()` — resolve to the
		// aliased target's length.
		if (decl?.alias_of) {
			const alias_base = decl.alias_of.split(".")[0];
			const base = status.values.findLast((v) => v.name === alias_base);
			if (base?.type?.is_array && base.type.length) {
				const len = int_literal(base.type.length as BaseNode);
				if (len !== undefined) return { lower: len, upper: len + 1 };
			}
		}
		return undefined;
	}
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const field = access.access as AccessFieldNode;
			if (field.name === "length") {
				if (access.target.node_type === "value") {
					const vn = access.target as ValueNode;
					let decl = status.values.findLast((v) => v.name === vn.value);
					// Follow an alias (e.g. `self` → the caller's receiver
					// `bodies`) so a generic `self.length` resolves to the
					// concrete array's length.
					if (decl?.alias_of) {
						const base_name = decl.alias_of.split(".")[0];
						const aliased = status.values.findLast((v) => v.name === base_name);
						if (aliased && (!decl.type?.is_array || !decl.type.length)) decl = aliased;
					}
					// Flow-sensitive `known_length` (e.g. from `if arr.length == 3`)
					// takes precedence over the static type length, which may be
					// unknown for `Array.with(...)`-constructed arrays.
					if (decl?.known_length !== undefined) {
						const len = decl.known_length;
						return { lower: len, upper: len + 1 };
					}
					if (decl?.type?.is_array && decl.type.length) {
						const len = int_literal(decl.type.length as BaseNode);
						if (len !== undefined) return { lower: len, upper: len + 1 };
					}
				}
				// alias: `len` bound to `arr.length()` / `arr.length`
				const aliased = expr_to_string(node, status);
				if (aliased) {
					const base = status.values.findLast((v) => v.name === aliased.split(".")[0]);
					if (base?.alias_of) {
						const tgt = base.alias_of.split(".")[0];
						const tdecl = status.values.findLast((v) => v.name === tgt);
						if (tdecl?.type?.is_array && tdecl.type.length) {
							const len = int_literal(tdecl.type.length as BaseNode);
							if (len !== undefined) return { lower: len, upper: len + 1 };
						}
					}
				}
			} else if (field.name === "cap") {
				// Resolve `buf.cap` (or `self.cap` inside a method) to the
				// minimum known capacity from a recent grow/alloc. Returns
				// an interval [cap, cap+1) so callers can compare numerically.
				const target_path = expr_to_string(access.target, status);
				if (target_path) {
					const cap = lookup_buffer_cap(target_path, status);
					if (cap !== undefined) return { lower: cap, upper: cap + 1 };
					// Inside a struct method, buffer_caps are keyed by the
					// callee's "self.X" path; resolve via the caller's alias.
					if (target_path.includes(".")) {
						const dot_idx = target_path.indexOf(".");
						const fallback = "self" + target_path.slice(dot_idx);
						if (fallback !== target_path) {
							const cap2 = lookup_buffer_cap(fallback, status);
							if (cap2 !== undefined) return { lower: cap2, upper: cap2 + 1 };
						}
					}
				}
			}
		}
		return undefined;
	}
	if (node.node_type === "op") {
		const op = node as OperationNode;
		if (op.op === "+" || op.op === "-") {
			const a = numeric_interval(op.left_value, status);
			const b = int_literal(op.right_value);
			if (a && b !== undefined) {
				const d = op.op === "+" ? b : -b;
				return { lower: a.lower + d, upper: a.upper + d };
			}
			const a2 = int_literal(op.left_value);
			const c = numeric_interval(op.right_value, status);
			if (a2 !== undefined && c) {
				const d = op.op === "+" ? a2 : -a2;
				return { lower: c.lower + d, upper: c.upper + d };
			}
		}
	}
	return undefined;
}

/**
 * Apply the NEGATION of a comparison condition as bounds.
 *
 * Used in two places:
 *   - after a `while` loop (e.g. `while idx >= cap` ⇒ afterwards `idx < cap`);
 *   - after a guard-clause `if` whose body always exits (e.g.
 *     `if i < 0 || i >= list.length { return }` ⇒ the fall-through establishes
 *     `i >= 0 && i < list.length`).
 *
 * Single comparisons set a bound on the bare variable (negating the operator).
 * A disjunction `A || B` negates to `!A && !B`, so both negated facts hold and
 * each is applied (De Morgan). A conjunction `A && B` negates to `!A || !B` — a
 * disjunction where neither fact is individually guaranteed — so nothing sound
 * can be applied and it is skipped.
 */
export function apply_negated_bounds(condition: BaseNode, status: CheckStatus) {
	if (condition.node_type !== "op") return;
	const op = condition as OperationNode;
	if (op.op === "||") {
		apply_negated_bounds(op.left_value, status);
		apply_negated_bounds(op.right_value, status);
		return;
	}
	if (op.op === "&&") return;
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
		// var OP expr  →  negate(OP): < → >=, <= → >, > → <=, >= → <
		rel = op.op === "<" ? ">=" : op.op === "<=" ? ">" : op.op === ">" ? "<=" : "<";
	} else {
		// expr OP var  →  flip then negate
		// var originally was on the right; from var's perspective op is flipped
		const flipped = op.op === "<" ? ">" : op.op === "<=" ? ">=" : op.op === ">" ? "<" : "<=";
		rel = flipped === "<" ? ">=" : flipped === "<=" ? ">" : flipped === ">" ? "<=" : "<";
	}

	if (rel === "<" || rel === "<=") {
		if (rel === "<=") {
			if (!var_decl.upper_bound_inclusive_exprs) var_decl.upper_bound_inclusive_exprs = [];
			if (!var_decl.upper_bound_inclusive_exprs.includes(expr)) {
				var_decl.upper_bound_inclusive_exprs.push(expr);
			}
			var_decl.upper_bound_expr = expr;
			return;
		}
		if (!var_decl.upper_bound_exprs) var_decl.upper_bound_exprs = [];
		if (!var_decl.upper_bound_inclusive_exprs) var_decl.upper_bound_inclusive_exprs = [];
		if (!var_decl.upper_bound_exprs.includes(expr)) {
			var_decl.upper_bound_exprs.push(expr);
		}
		var_decl.upper_bound_expr = expr;
	} else {
		if (!var_decl.lower_bound_exprs) var_decl.lower_bound_exprs = [];
		if (!var_decl.lower_bound_inclusive_exprs) var_decl.lower_bound_inclusive_exprs = [];
		if (rel === ">=") {
			if (!var_decl.lower_bound_inclusive_exprs.includes(expr)) {
				var_decl.lower_bound_inclusive_exprs.push(expr);
			}
		} else {
			if (!var_decl.lower_bound_exprs.includes(expr)) {
				var_decl.lower_bound_exprs.push(expr);
			}
		}
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
