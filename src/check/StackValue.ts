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
}
