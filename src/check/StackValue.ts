import BaseNode from "../nodes/BaseNode.ts";
import Type from "../nodes/Type.ts";

/**
 * Flow-sensitive bounds for one dotted access path on a StackValue (see
 * `StackValue.path_bounds`). Mirrors the shared bound fields, but scoped to
 * the exact path a contract or guard established them for.
 */
export interface PathBounds {
	upper?: string[];
	lower?: string[];
	upper_inclusive?: string[];
	lower_inclusive?: string[];
	range_lower?: number;
	range_upper?: number;
}

/**
 * A value (declaration, param etc) that is accessible at the current point
 */
export default interface StackValue {
	declaration: "const" | "var" | "mov";
	name: string;
	type: Type;
	/**
	 * Whether the value has been set, which is used to ensure that consts are set
	 * exactly once
	 */
	is_set?: boolean;
	start?: number;
	is_null?: boolean;
	/**
	 * For const declarations with a literal value, the compile-time value
	 * (number, string, or boolean). Used for constant condition evaluation.
	 */
	const_value?: number | string | boolean;
	/**
	 * Constraint expression from the declaration (e.g. `var int x: x > 5`)
	 */
	constraint?: BaseNode;
	/**
	 * For for-loop variables from a range (e.g. `for i of 0 .. n`),
	 * the evaluated lower and upper bounds (upper is exclusive).
	 */
	range_lower?: number;
	range_upper?: number;
	/**
	 * Flow-sensitive bounds established by enclosing if/while conditions or
	 * propagated from a function's return contract. Each entry is a canonical
	 * expression string (e.g. "list.length", "self.keys.cap") that the
	 * variable is known to be strictly less than (or ≤ / ≥ / > for the lower
	 * variants). Multiple bounds can be active simultaneously — verification
	 * succeeds if ANY active bound satisfies the constraint being checked.
	 */
	upper_bound_exprs?: string[];
	lower_bound_exprs?: string[];
	/**
	 * Inclusive variants: the variable is known to be `<= expr` (upper) or
	 * `>= expr` (lower). Unlike `upper_bound_exprs` (strict `<`) these do
	 * NOT satisfy a strict constraint (`x < expr`) on their own, since
	 * `x <= expr` allows `x == expr`. They only satisfy the matching
	 * inclusive constraint (`x <= expr`).
	 */
	upper_bound_inclusive_exprs?: string[];
	lower_bound_inclusive_exprs?: string[];
	/**
	 * @deprecated use upper_bound_exprs / lower_bound_exprs
	 */
	upper_bound_expr?: string;
	lower_bound_expr?: string;
	/**
	 * For `self` pushed during constraint evaluation: the actual variable name
	 * this refers to (e.g. "list"), so self.length can be resolved to list.length.
	 */
	alias_of?: string;
	/**
	 * For an object-level alias (`var Box b = a`): the owner variable whose
	 * instance b currently shares. Unlike `borrowed_from` (field/method borrows)
	 * this does NOT trigger borrow-invalidation when the owner is mutated — the
	 * alias and owner are the same object, so a mutation through one is visible
	 * through the other and the alias stays valid. It only signals that the
	 * owner's old instance must not be eagerly freed on reassignment (it would
	 * dangle the alias); the build then defers it.
	 */
	class_alias_of?: string;
	/**
	 * Block scope depth at which this variable was declared (status.scope_depth
	 * when pushed). Used by borrow-lifetime checking.
	 */
	decl_depth?: number;
	/**
	 * True for module-scope (file-global) `const`/`var` declarations. Such
	 * values are accessible from any function — including nested ones — because
	 * the backends emit them at file scope, so referencing one is NOT a closure
	 * capture. Only locals/params of an *enclosing* function are captures.
	 */
	is_global?: boolean;
	/**
	 * For borrowed class references (taken from a field access): the scope depth
	 * at which the borrow was created. The borrow may not be assigned/returned
	 * to a variable declared at a shallower depth (decl_depth < borrow_depth).
	 */
	borrow_depth?: number;
	/**
	 * For child-group borrows (a class reference taken from an owner's contents
	 * — a container element via `.at`/`.pop`, or a class field): the ultimate
	 * owner variable this borrow is rooted in. Used to invalidate the borrow
	 * when the owner is mutated (ref self / var self call), since the mutation
	 * may free or displace the contents the borrow points into.
	 */
	borrowed_from?: string;
	/**
	 * True once the owner named by `borrowed_from` has been mutated; reading the
	 * borrow thereafter is rejected. Cleared when the variable is re-assigned
	 * (re-borrowed or re-owned).
	 */
	borrow_invalidated?: boolean;
	/**
	 * True when this struct value's `view T` fields hold borrows taken from
	 * other variables (see `view_field_owners`). Drives escape checking:
	 * the instance may not be returned (unless every borrow roots at `self`)
	 * or assigned to an outer scope, since its bytes carry non-owning slices.
	 */
	has_view_borrows?: boolean;
	/**
	 * For a struct value with `has_view_borrows`: the owner variables its view
	 * fields currently borrow from. Reassignment/mutation of any owner
	 * invalidates the instance's view fields (recorded in CheckStatus.
	 * invalidated_view_structs); reading a view field afterwards is rejected.
	 */
	view_field_owners?: Set<string>;
	/**
	 * For Buffer variables: the minimum guaranteed capacity, established by
	 * calls to grow_int(N)/alloc_int(N)/alloc(N). Used to verify compile-time
	 * `i < buf.cap` constraints after a known-size allocation.
	 */
	known_min_cap?: number;
	/**
	 * Flow-sensitive known length for an array/string variable, established
	 * by a guard like `if arr.length == 3`. When set, `numeric_interval`
	 * resolves `arr.length` to this value (overriding the static type length,
	 * which may be unknown for `Array.with(...)`). Cleared on scope exit.
	 */
	known_length?: number;
	/**
	 * Bounds keyed by the full dotted path they were established for (e.g.
	 * "p.a" from a field-referencing out-contract `out.a < xs.length`
	 * substituted onto the binding `p`). Shared bound arrays cannot
	 * distinguish WHICH field of `p` a bound constrains, so dotted-path
	 * bounds recorded here stay precise: an access argument `p.a` carries
	 * exactly the bounds proven for "p.a", and `p.b` sees none of them.
	 */
	path_bounds?: Map<string, PathBounds>;
	/**
	 * For function-typed variables: the parameter types from the declared
	 * function signature. Used to infer parameter types on a lambda assigned
	 * later (e.g. `adder = (a, b) => a + b`).
	 */
	func_params?: { name: string; type: Type }[];
	/**
	 * For function-typed variables: the declared return type.
	 */
	func_return_type?: Type;
}
