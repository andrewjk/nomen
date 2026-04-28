import Type from "../nodes/Type.ts";

/**
 * A value (declaration, param etc) that is accessible at the current point
 */
export default interface StackValue {
	declaration: "const" | "var";
	name: string;
	type: Type;
	/**
	 * Whether the value has been set, which is used to ensure that consts are set
	 * exactly once
	 */
	is_set?: boolean;
}
