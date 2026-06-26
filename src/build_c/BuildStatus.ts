import BaseNode from "../nodes/BaseNode.ts";
import BitsetNode from "../nodes/BitsetNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import Type from "../nodes/Type.ts";

export default interface BuildStatus {
	root: BaseNode;
	structs: StructNode[];
	traits: TraitNode[];
	enums: EnumNode[];
	bitsets: BitsetNode[];
	headers: string;
	code: string;
	/**
	 * C companion code (functions with `aarch64_use_c` raw blocks).
	 * Emitted as a separate `.m`/`.c` file and linked with the assembly output.
	 */
	c_companion?: string;
	/**
	 * Functions whose bodies are compiled as C (via `aarch64_use_c`).
	 * Each entry records the function node, owning struct (if any), and the
	 * concatenated raw C code — used to generate the companion file.
	 */
	c_companion_functions?: { func: FunctionNode; struct_name?: string; raw_code: string }[];
	/**
	 * Build errors (e.g. missing arch block for the target architecture).
	 */
	build_errors?: { message: string; start: number }[];
	/**
	 * Declarations that were made in the current scope and will need to be freed
	 */
	scoped_declarations: DeclarationNode[];
	interpolate_string_counts: Set<number>;
	return_assign?: string;
	function_param_regs?: Map<string, string>;
	function_param_vars?: Set<string>;
	function_ref_params?: Set<string>;
	self_is_ref?: boolean;
	function_array_params?: Set<string>;
	function_variadic_params?: Set<string>;
	function_return_label?: string;
	moved_class_params?: Map<string, string>;
	heap_array_vars?: Set<string>;
	heap_class_arrays?: Map<string, number>;
	function_return_type?: Type;
	strings?: Map<string, string>;
	float_literals?: Map<string, string>;
	loop_labels?: { start: string; end: string; cleanup_depth?: number }[];
	heap_cleanup_stack?: {
		heap_strings: Set<string>;
		heap_slots: { offset: number; var_name?: string }[];
		struct_decls: { name: string; type_name: string; type_args?: Type[] }[];
	}[];
	struct_return_buffer?: string;
	return_buffer_stack_offset?: number;
	function_data?: string;
	nested_functions?: string;
	stack_size?: number;
	stack_offsets?: Map<string, number>;
	string_literal_names?: Set<string>;
	audit?: boolean;
	moved?: Set<string>;
	heap_returning_functions?: Set<string>;
	heap_strings?: Set<string>;
	/**
	 * String variables that are reassigned a freshly-allocated (heap) value at
	 * some point (e.g. `s = s + "x"` in a loop). Their initial literal value is
	 * heap-allocated too, so reassignment can always free the old value.
	 */
	force_heap_strings?: Set<string>;
	heap_string_arrays?: Map<string, number>;
	last_result_is_heap?: boolean;
	match_save_size?: number;
	current_struct?: StructNode;
	current_function_name?: string;
	/**
	 * Accumulates variable name → type across all scopes during building.
	 * Used to resolve types for monomorphized generic functions whose ValueNodes
	 * were never type-resolved by the check pass.
	 */
	variable_types?: Map<string, Type>;
	inline_functions?: Map<string, BaseNode>;
	/**
	 * Maps variable names to callee-saved registers (x23-x28) for loop register allocation.
	 * When present, emit_var_load/emit_var_store will use the register instead of stack.
	 */
	register_allocations?: Map<string, string>;
	callee_saved_regs_used?: Set<string>;
	platform: string;
	label_counter?: number;
}
