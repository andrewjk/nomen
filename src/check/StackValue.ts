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
	 * Flow-sensitive bounds established by enclosing if/while conditions.
	 * E.g. inside `while j < list.length`, j has upper_bound_expr = "list.length".
	 * Used to verify method constraints like `i < self.length` at the call site.
	 */
	upper_bound_expr?: string;
	lower_bound_expr?: string;
	/**
	 * For `self` pushed during constraint evaluation: the actual variable name
	 * this refers to (e.g. "list"), so self.length can be resolved to list.length.
	 */
	alias_of?: string;
}
