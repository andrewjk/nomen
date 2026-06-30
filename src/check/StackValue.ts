import BaseNode from "../nodes/BaseNode.ts";
import Type from "../nodes/Type.ts";

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
	 * Block scope depth at which this variable was declared (status.scope_depth
	 * when pushed). Used by borrow-lifetime checking.
	 */
	decl_depth?: number;
	/**
	 * For borrowed class references (taken from a field access): the scope depth
	 * at which the borrow was created. The borrow may not be assigned/returned
	 * to a variable declared at a shallower depth (decl_depth < borrow_depth).
	 */
	borrow_depth?: number;
	/**
	 * For Buffer variables: the minimum guaranteed capacity, established by
	 * calls to grow_int(N)/alloc_int(N)/alloc(N). Used to verify compile-time
	 * `i < buf.cap` constraints after a known-size allocation.
	 */
	known_min_cap?: number;
}
