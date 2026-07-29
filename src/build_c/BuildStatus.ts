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
	/**
	 * Top-level (root-scope) non-primitive `const` declarations, keyed by
	 * name. These are inlined at every use site by `build_value_node` rather
	 * than emitted as file-scope globals — the initializer is typically a
	 * struct constructor call, which is not a valid file-scope constant
	 * expression in C and would be bare instructions at module scope in
	 * aarch64. Populated once at root build.
	 */
	top_level_consts?: Map<string, DeclarationNode>;
	headers: string;
	code: string;
	/**
	 * C companion code (functions with `aarch64_use_c` raw blocks).
	 * Emitted as a separate `.m`/`.c` file and linked with the assembly output.
	 */
	c_companion?: string;
	/**
	 * File-scope C code emitted to the companion file before function bodies.
	 * Used for pool infrastructure, type definitions, and `#scope: file` raw
	 * blocks that need to appear at file scope rather than inline.
	 */
	file_scope_c?: string;
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
	 * Stack of every active scope's `scoped_declarations` frame (bottom = the
	 * enclosing function). Each scope-creating construct (function, if/else,
	 * while, for, switch-case) pushes the fresh `[]` it assigns to
	 * scoped_declarations, and pops it on exit. This lets break/continue
	 * reclaim declarations from the current scope AND all enclosing scopes up
	 * to the loop body before jumping — mirroring aarch64's
	 * emit_cleanup_to_loop_depth. Without it, `break` would leak every
	 * declaration in scopes it jumps out of (the scope-exit auto_free runs
	 * after the jump and is dead code).
	 */
	c_scope_stack?: DeclarationNode[][];
	/**
	 * Stack of frame indices (into c_scope_stack) marking each enclosing loop's
	 * BODY frame. break/continue free frames from the top down to (and
	 * including) the topmost entry here, then jump.
	 */
	c_loop_frame_depth?: number[];
	/**
	 * Per-function set of string variable names that are reassigned ONLY to
	 * borrowed values (e.g. `filename = init.args.at(1)`). For such a
	 * variable, `var string x = "literal"` skips strdup'ing the literal — the
	 * variable never owns a heap value, so a pre-emptive copy would leak when
	 * the borrow branch isn't taken. Populated by scan_borrow_only_strings at
	 * function entry; reset per function.
	 */
	c_borrow_only_strings?: Set<string>;
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
	 * Trait-typed LOCAL variables whose concrete storage is a `class` (e.g.
	 * `var Speaker s = Dog()` where Dog is a class). Such a local stores a
	 * pointer to the heap-allocated instance (not the inline struct value),
	 * so it can be reassigned to a different conforming class
	 * (`s = Cat()`). Keyed by variable name → the trait name. Dispatch and
	 * field access read the vtable through the stored pointer (the local is
	 * also tracked in `class_vars` so build_vtable_target passes it by
	 * value); scope-exit and reassignment reclaim it via the trait's
	 * `<Trait>_destroy` shim + free.
	 */
	trait_class_locals?: Map<string, string>;
	/**
	 * `ref` class parameters, emitted as double pointers (`struct T **`). The
	 * call site passes the address of the caller's pointer slot so the callee
	 * can reassign the caller's variable and reclaim the old instance. Use
	 * sites dereference once (`(*name)`); reassignments write `*name = ...`.
	 * Mirrors the aarch64 backend's `ref_class_slots`.
	 */
	ref_class_params?: Set<string>;
	/** Type of each `ref` class param, keyed by C name (see ref_class_params). */
	ref_class_param_types?: Map<string, import("../nodes/Type.ts").default>;
	/** Local variables declared as `var ref` (mutable aliases via pointer).
	 *  Reassigning one repoints the pointer rather than writing through it. */
	ref_local_vars?: Set<string>;
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
	/**
	 * Stack (fixed-size) C arrays whose elements own heap data — i.e. the
	 * element type is `string`, a `class`, or a struct that needs destroying.
	 * The backing array itself is not malloc'd (it's a local C array), but each
	 * element was, so they must be freed element-by-element at scope exit.
	 */
	stack_array_vars?: Set<string>;
	/**
	 * For each registered stack array (see `stack_array_vars`), the C text of
	 * the element-count expression (e.g. `3L`), captured at declaration time so
	 * build_auto_free can emit a correct `for` bound without rebuilding the
	 * type's length node.
	 */
	stack_array_lengths?: Map<string, string>;
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
	/**
	 * String variables that have been reassigned a BORROWED value (e.g.
	 * `filename = init.args.at(1)`, where `args.at()` returns a pointer into
	 * argv). Such variables no longer own their value and must NOT be freed at
	 * scope exit — freeing them would reclaim argv/container memory. Recorded
	 * at the reassignment (which may be in a nested scope) so auto_free, which
	 * runs in the declaration's scope, can skip them. Mirrors aarch64's
	 * `heap_strings` ownership tracking, which only frees freshly-allocated
	 * strings.
	 */
	string_borrow_vars?: Set<string>;
	/**
	 * Owned (heap) string variables, tracked in a set that persists across
	 * scope resets (unlike scoped_declarations). A reassignment inside a loop
	 * body (`s = s + "x"`) needs to know the outer-scope `s` is an owned string
	 * so it can free the displaced old value each iteration (otherwise it
	 * leaks — auto_free only runs once, at the declaration scope's exit).
	 */
	owned_string_vars?: Set<string>;
	heap_string_arrays?: Map<string, number>;
	last_result_is_heap?: boolean;
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
	 * Maps a class variable used as an alias SOURCE (`var Box b = a`) to the
	 * declaration node(s) of the alias(es) pointing at it. When the source is
	 * reassigned (`a = Box(99)`), ownership of the old instance transfers to
	 * its alias(es): their declarations are (re)added to scoped_declarations so
	 * they are destroyed/freed exactly once at scope exit. Mirrors aarch64's
	 * `mark_anchor_destroy` on the alias when its owner is reassigned.
	 */
	class_alias_source_map?: Map<string, import("../nodes/DeclarationNode.ts").default[]>;
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
	 * Set by build_float_operand before building a float-typed child expression.
	 * When a float binary operation sees this flag at its result point, it skips
	 * the `fmov x0, d0` (leaving the result in d0) and clears the flag. This
	 * eliminates the redundant d0→x0→d0 round-trip for nested float expression
	 * chains (e.g. `(zr+zr)*zi+ci`). Only consumed by the immediate child float
	 * op: each float op saves+clears the flag before building its own operands,
	 * so nested grandchildren can't steal it.
	 */
	float_result_in_d0?: boolean;
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
	 * Counter for generating unique spawn-site IDs (struct + trampoline names).
	 */
	spawn_counter?: number;
	/**
	 * Stack of active async-nursery IDs. When non-empty, build_spawn_node
	 * pushes the pthread handle into the topmost nursery's handle array
	 * instead of detaching; build_async_block_node joins them all at exit.
	 */
	nursery_stack?: number[];
	/**
	 * aarch64-only: per-nursery stack frame offsets for the futures array,
	 * count slot, and (if timeout) deadline slot. Spawns inside a nursery
	 * pass these addresses to the submit helper so concurrent nursery
	 * invocations (e.g. nested async blocks running in parallel tasks) don't
	 * share state. Each entry is the offset from FP at the async-block frame.
	 */
	nursery_offsets?: Map<
		number,
		{
			futures_off: number;
			count_off: number;
			deadline_off?: number;
		}
	>;
	/**
	 * Tracks which struct body typedefs have already been emitted to avoid
	 * duplicate definitions when nested structs are also emitted at root level.
	 */
	emitted_struct_bodies?: Set<string>;
	/**
	 * Per-build set of allocation declarations (hoisted `_param_N` temps)
	 * that have already been emitted, so the inline `if (node.allocations)`
	 * path in `build_node` and the per-statement `emit_allocations` helper
	 * don't double-emit on a single backend. The AST is shared across the
	 * aarch64 and C builds (the test harness parses once, builds twice), so
	 * we can't mutate `node.allocations` to clear-as-we-go; this set is the
	 * per-build idempotency guard.
	 */
	emitted_allocations?: Set<unknown>;
	/**
	 * Tracks which file-scope raw C blocks have already been emitted to
	 * headers. When a generic struct (e.g. Task<T>) is monomorphized, its
	 * #init file-scope block (pool infrastructure, type defs, etc.) would be
	 * emitted once per instantiation. This set deduplicates by content hash.
	 */
	emitted_file_scope_blocks?: Set<string>;
	/**
	 * aarch64-only: read-only vtable data (per-struct trait function-pointer
	 * tables + the per-struct traits array), accumulated during struct build
	 * and appended after all code so the addresses are reachable via the
	 * literal pool. Mirrors the C backend's `_Struct_traits` / `_get_trait_func`.
	 */
	vtable_data?: string;
}
