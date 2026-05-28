import BaseNode from "../nodes/BaseNode.ts";
import BitsetNode from "../nodes/BitsetNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
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
	 * Declarations that were made in the current scope and will need to be freed
	 */
	scoped_declarations: DeclarationNode[];
	interpolate_string_counts: Set<number>;
	return_assign?: string;
	function_param_regs?: Map<string, string>;
	function_param_vars?: Set<string>;
	function_ref_params?: Set<string>;
	function_array_params?: Set<string>;
	function_return_label?: string;
	moved_class_params?: Map<string, string>;
	heap_array_vars?: Set<string>;
	heap_class_arrays?: Map<string, number>;
	function_return_type?: Type;
	strings?: Map<string, string>;
	loop_labels?: { start: string; end: string; cleanup_depth?: number }[];
	heap_cleanup_stack?: {
		heap_strings: Set<string>;
		heap_slots: { offset: number; var_name?: string }[];
		struct_decls: { name: string; type_name: string; type_args?: Type[] }[];
	}[];
	struct_return_buffer?: string;
	function_data?: string;
	nested_functions?: string;
	stack_size?: number;
	stack_offsets?: Map<string, number>;
	string_literal_names?: Set<string>;
	audit?: boolean;
	moved?: Set<string>;
	heap_returning_functions?: Set<string>;
	heap_strings?: Set<string>;
	heap_string_arrays?: Map<string, number>;
	last_result_is_heap?: boolean;
	match_save_size?: number;
}
