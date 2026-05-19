import BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import Type from "../nodes/Type.ts";
import type CompileError from "../types/CompileError.ts";
import type StackValue from "./StackValue.ts";

export default interface CheckStatus {
	/**
	 * The stack of nodes, with the current node being checked on top
	 */
	stack: BaseNode[];
	/**
	 * Types (values, structs and traits) in scope
	 */
	types: string[];
	/**
	 * For declarations and assignments, store the type if set, for use in
	 * ambiguous nodes such as arrays
	 */
	expected_type?: Type;
	/**
	 * Values (variables, params etc) in scope
	 */
	values: StackValue[];
	/**
	 * Structs in scope
	 */
	structs: StructNode[];
	/**
	 * Traits in scope
	 */
	traits: TraitNode[];
	/**
	 * Functions in scope
	 */
	functions: FunctionNode[];
	/**
	 * Declarations that will need to be added before the current node, for
	 * storing paramater values etc that may need auto-freeing
	 */
	allocations: DeclarationNode[];
	/**
	 * A counter for making new var names that (hopefully) don't clash. It needs
	 * to be in an object so that it continues to be incremented after the status
	 * is cloned
	 */
	var_name_counter: { value: number };
	/**
	 * Errors that have been encountered
	 */
	errors: CompileError[];
}
