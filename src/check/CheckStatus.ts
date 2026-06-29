import BaseNode from "../nodes/BaseNode.ts";
import BitsetNode from "../nodes/BitsetNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
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
	 * Enums in scope
	 */
	enums: EnumNode[];
	/**
	 * Bitsets in scope
	 */
	bitsets: BitsetNode[];
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
	 * Type parameters currently in scope (e.g. T in struct List<T>)
	 */
	type_params: string[];
	allow_null_value?: boolean;

	/**
	 * True when checking the left side of an assignment — uninitialized vars
	 * are allowed here since they are about to be set
	 */
	is_assignment_target?: boolean;

	/**
	 * Variables that have been moved via `mov` and can no longer be used
	 */
	moved_variables?: Set<string>;

	/**
	 * Errors that have been encountered
	 */
	errors: CompileError[];

	/**
	 * Map from buffer access path (e.g. "buf", "self.items") to the minimum
	 * guaranteed capacity, established by recent calls to grow_int(N)/alloc(N)/
	 * alloc_int(N). Used by the constraint evaluator to verify
	 * compile-time `i < buf.cap` constraints after a known-size allocation.
	 * Cleared on mutation/reassignment of the buffer variable.
	 */
	buffer_caps?: Map<string, number>;

	/**
	 * Return-contract bounds (canonical bound expression trees) awaiting the
	 * LHS variable to be pushed into scope. When a call's result initializes a
	 * declaration, the variable isn't in `values` yet during the initializer
	 * check, so the return contract can't bind directly. It is stashed here
	 * keyed by the variable name and applied by `check_declaration_node` once
	 * the variable is pushed.
	 */
	pending_return_bounds?: Map<string, BaseNode[]>;
}
