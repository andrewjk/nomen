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
	/**
	 * Old class instances displaced by variable reassignment (`h = Holder(...)`)
	 * whose reclamation is deferred to scope exit. Eagerly freeing them at the
	 * reassignment would invalidate borrows of the old value's fields (e.g.
	 * `var Box b = h.c; h = Holder(...)` must keep `b` valid until scope exit).
	 * Mirrors aarch64's anchor-slot deferred reclamation. Each entry is a temp
	 * C pointer (declared inline at the reassignment, in the same C block as
	 * the scope-exit free) plus its class name and nullability. Saved/restored
	 * per scope alongside scoped_declarations.
	 */
	deferred_frees?: { temp: string; struct_name: string; is_nullable: boolean }[];
	interpolate_string_counts: Set<number>;
	return_assign?: string;
	function_param_regs?: Map<string, string>;
	function_param_vars?: Set<string>;
	function_ref_params?: Set<string>;
	/**
	 * Variables and parameters whose type is a `class` (heap-allocated).
	 * Class-typed slots are emitted as pointers in C and use `->` for field
	 * access, but — unlike `function_ref_params` entries — they must NOT be
	 * dereferenced with `*` at value-use sites (the pointer itself IS the
	 * value; `var q = p` copies the pointer to create an alias).
	 */
	class_vars?: Set<string>;
	/**
	 * When true, the next value-node build of a ref/var param should NOT be
	 * prefixed with `*` (i.e. the caller needs the pointer itself, e.g. to
	 * pass the address to another function or to a struct method).
	 */
	suppress_dereference?: boolean;
	/**
	 * When true, `self` refers to a local by-value variable (e.g. inside a
	 * custom #init body), not a pointer param. Prevents the `self → _self`
	 * rename in build_value_node.
	 */
	self_is_local?: boolean;
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
		heap_slots: {
			offset: number;
			var_name?: string;
			/**
			 * When set, freeing this anchor slot at scope/return/break exit
			 * first runs the type's `#destroy` and field destroys (e.g. frees
			 * owned class fields). Used to defer reclamation of a class
			 * instance replaced by reassignment: the old instance stays alive
			 * (so borrows of its fields remain valid) until the scope ends.
			 */
			destroy_type?: string;
			destroy_type_args?: Type[];
			/**
			 * True when the slot holds a nullable class instance — the
			 * instance pointer may be 0 (null), so destroy/free must be
			 * guarded by a `cbz` to avoid dereferencing null.
			 */
			is_nullable?: boolean;
		}[];
		struct_decls: { name: string; type_name: string; type_args?: Type[]; is_nullable?: boolean }[];
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
	/**
	 * Maps a class-typed variable to the index (in heap_cleanup_stack) of the
	 * frame it was declared in. Used when an object-level alias (which has no
	 * anchor of its own) is reassigned to a fresh instance: the new instance
	 * must be anchored in the variable's declaration frame so it survives
	 * nested scopes (e.g. loop bodies) and is destroyed once at the right exit.
	 */
	class_decl_frame?: Map<string, number>;
	/**
	 * Class-typed variables that were declared as object-level aliases
	 * (`var Box q = p`, or a field-borrow `var Box b = h.c`) — i.e. NOT tracked
	 * via scoped_declarations. Such a variable never gets a #destroy at scope
	 * exit through the scoped_declarations path, so any instance it comes to own
	 * (via reassignment to a fresh value) must be flagged for destroy on its
	 * anchor slot. Recorded once at declaration so it survives scoped resets.
	 */
	class_alias_vars?: Set<string>;
	/**
	 * Class variables that have been used as the source of an alias
	 * (`var Box b = a`). When such a variable is later reassigned
	 * (`a = Box(99)`), the old value must NOT be eagerly freed — the alias
	 * `b` still references it. Instead the old value is left to leak (the
	 * C backend has no deferred-reclamation mechanism like aarch64's anchor
	 * slots). This is a conservative safety check to prevent use-after-free.
	 */
	aliased_class_sources?: Set<string>;
	/**
	 * Maps an object-level alias var name (`var R q = p`, or a field borrow
	 * `var Box b = h.c`) to the stack offset of a boolean flag that tracks at
	 * runtime whether the alias currently *owns* its value. An alias only
	 * becomes the owner of its value after its first reassignment to a fresh
	 * instance — its initial value is shared with the original owner and must
	 * NOT be freed. The build is static, so inside a loop the eager-free
	 * decision can't key off a build-time `owns_current` check (it's evaluated
	 * once, before the alias has an anchor); it must branch on this runtime
	 * flag instead. The flag lives in the alias's declaration frame (a fixed
	 * stack offset), so it persists across loop iterations.
	 */
	alias_owns_flag?: Map<string, number>;
	/**
	 * For a `ref` CLASS param, the call site passes the ADDRESS of the caller's
	 * pointer slot (so the callee can reassign it). The callee loads the
	 * instance into the param's callee-saved register (so field access works
	 * unchanged) and stores that &slot address here (param name → stack offset),
	 * so reassignment can free the caller's old instance and store the new one
	 * back through the slot.
	 */
	ref_class_slots?: Map<string, number>;
	inline_functions?: Map<string, BaseNode>;
	/**
	 * Maps variable names to callee-saved registers (x23-x28) for loop register allocation.
	 * When present, emit_var_load/emit_var_store will use the register instead of stack.
	 */
	register_allocations?: Map<string, string>;
	callee_saved_regs_used?: Set<string>;
	/**
	 * Loop-invariant cache: maps a Buffer target key (e.g. "flags" or
	 * "self.digits") to the callee-saved register holding its pre-loaded
	 * data pointer. Populated lazily on first Buffer access inside a loop;
	 * cleared when the loop exits.
	 */
	buffer_data_cache?: Map<string, string>;
	platform: string;
	label_counter?: number;
	/**
	 * Tracks which struct body typedefs have already been emitted to avoid
	 * duplicate definitions when nested structs are also emitted at root level.
	 */
	emitted_struct_bodies?: Set<string>;
}
