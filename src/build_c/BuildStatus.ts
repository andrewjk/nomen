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
	 * Which translation unit this build is emitting, for the System-lib
	 * tiering split:
	 * - "all" (default/undefined): emit everything into one TU (the
	 *   historical single-translation-unit behaviour).
	 * - "system": emit only non-generic-System definitions (the stable
	 *   runtime that can be precompiled once into a shared object).
	 * - "user": emit everything else (user code + generics instantiated
	 *   with user types + the program's literals/vtables).
	 * Set by build(); consulted by build_block_node (to skip nodes of the
	 * wrong origin) and the build.ts/build_root_node tail (to route runtime
	 * helpers + declarations).
	 */
	emit_mode?: "all" | "system" | "user";
	/**
	 * When set (user-TU builds), struct names that are defined in the
	 * precompiled system.o. `is_system_definition` uses this to decide which
	 * structs the user TU must emit itself (anything NOT in this set) vs.
	 * reference from system.o — so a generic/tuple the canonical didn't
	 * instantiate is generated per-test instead of left undefined.
	 */
	system_struct_names?: Set<string>;
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
	 * C-backend lambda definitions (anonymous functions used as values —
	 * call arguments, declaration/assignment initializers). C may not nest a
	 * function definition inside an expression, so build_lambda_value
	 * buffers each definition here; build_root_node flushes the buffer at
	 * file scope after the statement walk (main.h carries the prototypes, so
	 * definition order among file-scope functions is irrelevant).
	 */
	lambda_definitions?: string;
	/**
	 * Closure support (docs/CLOSURE_PLAN.md). A func-typed VALUE is a
	 * `struct nomen_closure *` — { code, env, owned }. These flags/buffers
	 * back the descriptor ABI: the struct definition is emitted once per TU;
	 * thunk definitions (named functions used as values — a thunk forwards
	 * `(env, args…)` to the real function, whose signature is unchanged)
	 * buffer here and flush at file scope next to lambda_definitions; the
	 * descriptor map memoizes one static descriptor per target per TU.
	 */
	closure_runtime_emitted?: boolean;
	closure_definitions?: string;
	closure_descriptors?: Map<string, string>;
	/**
	 * Active closure env while building a lambda body (CLOSURE_PLAN Phase 2):
	 * captured name → the C lvalue expression that reads it (`_env->name`).
	 * Names shadowed by the lambda's own params/locals are excluded at the
	 * lookup site.
	 */
	closure_env?: Map<string, string>;
	/**
	 * aarch64 closure capture env (CLOSURE_PLAN Phase 2): the frame slot
	 * holding the current lambda's env pointer, and each capture's field
	 * offset within it (8 bytes each, scalar captures).
	 */
	closure_env_slot?: number;
	closure_env_offsets?: Map<string, number>;
	/** Env struct typedefs already emitted (per TU, by struct name). */
	closure_env_types?: Set<string>;
	/**
	 * Module-level statements that cannot live at C file scope (an `async`
	 * block, an expression statement, a `var` whose initializer is a call —
	 * none are valid file-scope C) collected by build_block_node's root scan.
	 * build_function_node splices them into `main`'s body as a prologue (in
	 * source order), where their declarations become scoped locals freed at
	 * main's exit.
	 */
	module_init_statements?: BaseNode[];
	/**
	 * Functions whose bodies are compiled as C (via `aarch64_use_c`).
	 * Each entry records the function node, owning struct (if any), and the
	 * concatenated raw C code — used to generate the companion file.
	 */
	c_companion_functions?: {
		func: FunctionNode;
		struct_name?: string;
		raw_code: string;
	}[];
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
	 * Stack of write-back callbacks for enclosing `for ref x of arr` loops.
	 * Each callback emits the code that persists the (possibly mutated) loop
	 * variable back into its array slot. break/continue invoke the top entry
	 * before jumping so mutations aren't lost on early exit. undefined for
	 * non-ref loops.
	 */
	loop_writebacks?: ((() => void) | undefined)[];
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
	deferred_frees?: {
		temp: string;
		struct_name: string;
		is_nullable: boolean;
	}[];
	interpolate_string_counts: Set<number>;
	return_assign?: string;
	/**
	 * The byte size of the return_assign join slot (16 for a fat string, 8
	 * for scalars/pointers). The branch-result store (build_let_node /
	 * build_return_node) needs it to store BOTH halves of a fat string — the
	 * join name is not in scoped_declarations (the match arms swap the frame
	 * out), so find_var_size alone would return 8 and drop the len half.
	 */
	return_assign_size?: number;
	/**
	 * Set while building the branches of a string-typed match/switch/if
	 * EXPRESSION whose branches are mixed (at least one produces a fresh owned
	 * heap string, e.g. an interpolation): every non-owned branch value
	 * (literal, bare variable, field borrow, container borrow) is strdup'd at
	 * its assignment to the return_assign target so the join variable
	 * uniformly owns its result and can be freed once at scope exit. Set by
	 * build_declaration_node / build_return_node on both backends; consumed by
	 * build_let_node.
	 */
	join_needs_owned_string?: boolean;
	/**
	 * Join variables (match/switch/if-as-expression results) normalized to
	 * own their string result per-branch (see join_needs_owned_string): the
	 * inferred type may claim `static` (a literal branch wins the is_static
	 * merge), so auto_free needs this explicit record to free them at scope
	 * exit. Unlike owned_string_vars this contains ONLY normalized joins.
	 */
	string_join_owned_vars?: Set<string>;
	function_param_regs?: Map<string, string>;
	function_param_vars?: Set<string>;
	/**
	 * aarch64 only. The current function's raw `#arch: aarch64` param-reload
	 * plan (see build_aarch64/utils/raw_reload.ts): a raw asm block spliced
	 * anywhere other than the body's entry point must reload its parameters'
	 * entry ABI registers from the prologue homes before its first
	 * instruction. Each prologue builder installs a plan around its body
	 * build and restores the enclosing one after (nested/inline builds must
	 * not splice the outer function's reloads into their own raw blocks).
	 */
	raw_param_reloads?: import("../build_aarch64/utils/raw_reload.ts").RawParamReloadPlan;
	/**
	 * The current function's/method's parameter types (aarch64), recorded at
	 * prologue time. Loop promotion resolves a candidate with no scoped
	 * declaration and no body declare record (i.e. a parameter) through this
	 * map so FLOAT params ride the float register pool — the legacy ""→int
	 * default claimed an x-register floats never use, starving both pools
	 * (mandelbrot's mbrot ci/cr). Nested function builds reset and restore it
	 * alongside the other param-tracking sets.
	 */
	function_param_types?: Map<string, Type>;
	function_ref_params?: Set<string>;
	/**
	 * Names of the current function's/method's `view T` parameters. On C
	 * these are nomen_view locals; on aarch64 they live as (ptr, len) stack
	 * pairs. Used to recognize bare view-param names as view VALUES at call
	 * sites and declarations (an owned→view conversion must not wrap them).
	 */
	function_view_params?: Set<string>;
	/**
	 * Variables and parameters whose type is a `class` (heap-allocated).
	 * Class-typed slots are emitted as pointers in C and use `->` for field
	 * access, but — unlike `function_ref_params` entries — they must NOT be
	 * dereferenced with `*` at value-use sites (the pointer itself IS the
	 * value; `var q = p` copies the pointer to create an alias).
	 */
	class_vars?: Set<string>;
	/**
	 * Scope snapshots for `class_vars` (C backend): enter_c_scope pushes the
	 * enclosing set and installs a COPY, leave_c_scope restores it — the
	 * same copy-on-enter treatment the aarch64 backend gives
	 * `stack_offsets_frames` / `trait_class_frames`. The set is name-keyed,
	 * so without per-scope copies a class-backed local's entry outlived its
	 * scope and poisoned a same-named variable in a sibling scope (e.g. a
	 * `void *`-backed `var T s = Dog()` followed by a `struct Drone`-backed
	 * `var T s = Drone()`: the sibling's vtable dispatch read the stale
	 * entry and passed the struct by value where a pointer was expected).
	 */
	class_vars_frames?: Set<string>[];
	/**
	 * AARCH64-BACKEND ONLY. Scope frames for trait-typed LOCAL variables
	 * whose concrete storage matters to dispatch:
	 *
	 *  - `name → trait` — the local's concrete storage is a `class` instance
	 *    (`var Speaker s = Dog()`): the slot holds a POINTER to the heap
	 *    instance, so vtable dispatch must dereference it once, and
	 *    reassignment reclaims the displaced instance via the trait's
	 *    `<Trait>_destroy` shim + free.
	 *  - `name → null` — a trait-typed local backed by inline (value-struct)
	 *    storage exists in this frame under this name: it must BLOCK any
	 *    inherited class-backed binding (an outer sibling's stale binding
	 *    would deref the inline struct's first field as a vtable pointer).
	 *
	 * One frame per scope, copy-on-enter (see enter_scope_frame), so an
	 * inner scope's re-binding dies with its frame and reads resolve to the
	 * enclosing binding afterwards — the same treatment
	 * `register_allocations` gets. The C backend does not use this: its
	 * record lives on the DeclarationNode (`trait_class_trait`), which is
	 * scope-correct by construction (a name-keyed body-global entry there
	 * poisoned same-named variables in sibling/shadowing scopes, emitting
	 * `<Trait>_destroy(v)` for int/string elements — invalid C).
	 */
	trait_class_frames?: Map<string, string | null>[];
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
	/**
	 * When the current function returns a nullable struct value type, this
	 * holds the C name of the hidden out-parameter (`unsigned char *_ret_has`)
	 * the callee writes (0 for null, 1 for value). Set in build_function_node;
	 * read in build_return_node. The caller (build_function_call_node /
	 * build_declaration_node) materialises both the struct value and this flag.
	 */
	nullable_ret_has_param?: string;
	/**
	 * Set by a consumer that's about to build a function call returning a
	 * nullable struct value type. When set, build_function_call_node emits
	 * `&<name>` as the trailing `_ret_has` argument, writing the callee's
	 * null/non-null signal into the named local. The consumer reads the flag
	 * from that local after the call. When unset, the call is wrapped in a
	 * statement-expression with a throwaway flag temp (used by expression
	 * contexts that don't care about nullness).
	 */
	current_nullable_call_flag?: string;
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
		struct_decls: {
			name: string;
			type_name: string;
			type_args?: Type[];
			is_nullable?: boolean;
		}[];
	}[];
	struct_return_buffer?: string;
	return_buffer_stack_offset?: number;
	/**
	 * aarch64 only. True while building a call whose sret destination has
	 * already been loaded into x8 by the surrounding context (a struct-typed
	 * declaration initialiser passes the local's address). The call emitter
	 * must not allocate its own `_call_ret_` temp or overwrite x8. Distinct
	 * from `struct_return_buffer` being set by the ENCLOSING function's own
	 * struct return — that case still requires the temp, because x8 is
	 * caller-saved and holds garbage by the time the call runs.
	 */
	call_x8_preset?: boolean;
	/**
	 * aarch64 only. Struct/trait/enum-with-data params that did NOT get a
	 * callee-saved register (the x19..x22 pool was exhausted) and were spilled
	 * to a local slot. Under the by-address struct param convention the slot
	 * holds the POINTER to the caller's struct — emit_var_address must load
	 * the pointer (`ldr`), not take the slot's address (`add`).
	 */
	function_struct_param_slots?: Set<string>;
	/**
	 * Functions/methods (by emitted label) whose CLASS-typed return is a
	 * borrowed reference (e.g. `return move got` where `got = xs.at(i)`).
	 * A class declaration initialized from such a call is a borrow — it must
	 * NOT be destroy-tracked at scope exit (the callee's owner frees the
	 * instance). See build_common/scan_borrow_returns.ts.
	 */
	borrow_returning_functions?: Set<string>;
	/**
	 * aarch64 only. The scoped_declarations arrays of ENCLOSING scopes while
	 * an if/while/for/switch/match body is being built (each swaps in a fresh
	 * frame — see enter_scope_frame/exit_scope_frame). A `return` inside the
	 * body must clean up those outer frames' declarations too, and move
	 * marking must recognize outer-scope locals.
	 */
	outer_scope_declarations?: DeclarationNode[][];
	/**
	 * aarch64 only. Saved stack_offsets maps of ENCLOSING scope frames (see
	 * enter_scope_frame/exit_scope_frame). Each frame builds against a COPY of
	 * the enclosing map so a declaration inside it (e.g. a shadowing `var x`)
	 * cannot clobber an outer same-named local's slot entry; exiting the frame
	 * restores the enclosing map. Without this, reads AFTER the frame resolve
	 * to the inner slot — diverging from the C backend (where the C compiler
	 * scopes the locals) and from the outer variable's actual storage.
	 */
	stack_offsets_frames?: Map<string, number>[];
	/**
	 * C only. Post-statement frees for VALUE-struct string fields released at
	 * a `move` call site (the callee's store_T deep-copied them and the decl
	 * was spliced out of scoped_declarations). The call may sit inside a
	 * larger expression, so the frees are buffered here and appended by
	 * build_node once the statement is complete.
	 */
	pending_string_releases?: string[];
	/**
	 * aarch64 only. VALUE-struct locals whose `string` field was assigned a
	 * heap-owned value ("var.field" keys, e.g. "u.text"). Value-struct string
	 * fields are NOT freed by the struct destroy (they may be rodata from
	 * construction), so ownership is tracked per assignment: the recorded
	 * fields are released at scope exit — including when the struct was
	 * `move`-stored into a container (store_T strdups its own copy, so the
	 * source's heap string is otherwise abandoned). Cleared when the struct
	 * is returned (the sret byte-copy transfers the string pointers).
	 */
	heap_string_fields?: Set<string>;
	function_data?: string;
	nested_functions?: string;
	stack_size?: number;
	stack_offsets?: Map<string, number>;
	string_literal_names?: Set<string>;
	/** Label → runtime byte length for folded/named string literal data
	 * (the fat string's len half is a compile-time constant — no strlen). */
	string_literal_lengths?: Map<string, number>;
	audit?: boolean;
	/** FP-reassociation opt-in (build `fast_math`): float loop reductions
	 *  may vectorize under NEON (results may differ in the last ulp). */
	fast_math?: boolean;
	/** Destination hint (ASM_PLAN_2 tranche C): when set to a promoted
	 *  d-register, the ROOT float operation of an assignment RHS emits
	 *  directly into it instead of d0 + writeback fmov. Consume-once: the
	 *  root op clears it so nested sub-operations never write the target
	 *  (RHS reads of the target need the old value until the final fused
	 *  instruction, which reads its sources before writing). */
	float_dest_hint?: string;
	/** Destination hint, integer side (ASM_PLAN_2 tranche F): when set to a
	 *  promoted x-register, the ROOT integer operation of an assignment or
	 *  declaration initializer emits directly into it instead of x0 +
	 *  writeback move. Consume-once (the root op clears it, so nested
	 *  sub-operations keep the scratch discipline; the target's old value
	 *  stays readable until the final instruction, which reads its sources
	 *  before writing). Only ever set for callee-saved x23-x28 targets —
	 *  a call inside the RHS would clobber caller-saved ext-pool registers
	 *  (x10-x15) before the root op reads its sources. */
	int_dest_hint?: string;
	/** Full-unroll index substitution (ASM_PLAN_2 tranche E): while the
	 *  unroller emits copy k of a fixed-trip loop whose body reads the
	 *  induction as an array index, this maps the induction name to the
	 *  literal k — reads become immediate loads. Cleared after the copies
	 *  (the loop itself is deleted; a post-loop store sets the induction
	 *  to the trip count). */
	induction_const?: Map<string, number>;
	moved?: Set<string>;
	heap_returning_functions?: Set<string>;
	/**
	 * Strings that currently OWN their heap bytes because a plain `s = t`
	 * assignment strdup'd (or transferred) an owned copy into them
	 * (assignment value semantics). auto_free adds this as a positive term to
	 * the string-free condition, so the target frees its copy at scope exit
	 * even when its declaration initializer wouldn't classify as owned.
	 * Mirrors aarch64's `heap_strings` set.
	 */
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
	 * Declaration NODES whose borrow-INITIALIZED string was strdup'd into an
	 * owned copy at the declare (`var string b = src.at(0)` where the
	 * force-heap scan proved `b` receives a heap value later — the reassign
	 * and scope-exit frees are emitted unconditionally, so every value `b`
	 * can hold must be heap-owned). Keyed by declaration object identity (not
	 * name) so a shadowing declaration can't inherit the override.
	 */
	c_owned_borrow_inits?: Set<DeclarationNode>;
	/**
	 * String variables whose ownership was TRANSFERRED by a move-on-last-use
	 * declare (`var u = t` where t is proven dead after — STRING_PLAN tranche
	 * 4). The transferred-to variable frees the bytes at its own scope exit,
	 * so auto_free must skip the moved-from variable (freeing both would
	 * double-free). Mirrors aarch64's heap_strings deletion on transfer.
	 */
	moved_string_vars?: Set<string>;
	/**
	 * Owned (heap) string variables, tracked in a set that persists across
	 * scope resets (unlike scoped_declarations). A reassignment inside a loop
	 * body (`s = s + "x"`) needs to know the outer-scope `s` is an owned string
	 * so it can free the displaced old value each iteration (otherwise it
	 * leaks — auto_free only runs once, at the declaration scope's exit).
	 */
	owned_string_vars?: Set<string>;
	heap_string_arrays?: Map<string, number>;
	/** Heap array buffers whose string ELEMENTS are owned heap copies
	 *  (e.g. `Array.with("x", n)` strdups each slot) — scope-exit destroy
	 *  must free every slot's ptr half before freeing the buffer. Unlike
	 *  heap_string_arrays (rodata rows), these own their bytes. */
	heap_owned_string_arrays?: Set<string>;
	last_result_is_heap?: boolean;
	current_struct?: StructNode;
	current_function_name?: string;
	/**
	 * The FunctionNode currently being built. Gives the body access to its
	 * own parameter signatures — notably the SUBSTITUTED func-typed params
	 * of a monomorphized generic body, which the call-site closure cast
	 * needs (the synthesized callee on the call node may still carry `T`).
	 */
	current_function?: import("../nodes/FunctionNode.ts").default;
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
	 * C backend counterpart of `alias_owns_flag`: maps an object-level alias
	 * var name to the emitted `int` flag variable (initialized to 0 at the
	 * alias declaration). A reassignment sets it to 1 and frees the old
	 * instance only when it is already 1 (the alias owns it) — a runtime
	 * decision, so a loop that reassigns the alias reclaims every former
	 * instance from iteration 2 on while the first iteration leaves the
	 * shared original for its owner.
	 */
	c_alias_owns_flags?: Map<string, string>;
	/**
	 * C backend: the scoped-declarations FRAME (by reference) in which a
	 * class alias was declared. A reassignment registers the alias's exit
	 * destroy in that frame (not the current one), so an alias reassigned
	 * inside a loop body is destroyed once at its declaration scope's exit.
	 */
	alias_decl_frames?: Map<string, import("../nodes/DeclarationNode.ts").default[]>;
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
	/**
	 * Saved register_allocations maps of ENCLOSING scope frames (aarch64
	 * only — stage 3 of the NIR allocator). enter_scope_frame swaps in a
	 * COPY (mirroring stack_offsets) so a decl-site binding inside the frame
	 * (same-named locals in sibling scopes must each bind their own
	 * register) cannot leak past the frame exit; reads after the frame
	 * resolve to the enclosing binding or none.
	 */
	register_allocations_frames?: (Map<string, string> | undefined)[];
	/**
	 * aarch64-only (ASM_PLAN_2 tranche G stage 3): decl-site register
	 * bindings from the NIR-level allocator, keyed by the lowering's
	 * deterministic `name@N` declare keys. emit_stmt_from_nir binds the
	 * register into the CURRENT scope frame's register_allocations right
	 * before the declare builds — two sibling scopes declaring the same
	 * name each bind their own register, where the function-wide name map
	 * could hold only one. Cleared wherever register_allocations is cleared
	 * (inline expansions, method/init/destroy body builds) so a nested
	 * body's declare keys can never resolve against an enclosing function's
	 * table.
	 */
	nir_site_allocs?: Map<string, { name: string; reg: string }>;
	callee_saved_regs_used?: Set<string>;
	/**
	 * aarch64-only (ASM_PLAN_2 tranche G): caller-saved ext registers
	 * (x12-x15) claimed by the NIR-level function allocator for
	 * call-free-contained variable ranges. Unlike register_allocations —
	 * which the inline-expansion path CLEARS so the inline body can't see
	 * the caller's name bindings — this set survives inline builds, so a
	 * loop promotion inside an inline-expanded body cannot claim one of
	 * these registers while the caller's variable is live across the
	 * expansion (an inline expansion is call-free: its range may legally
	 * span it).
	 */
	nir_caller_saved_claimed?: Set<string>;
	/**
	 * aarch64-only (ASM_PLAN_2 tranche G stage 2): interference facts from
	 * the NIR-level function allocator, so LOOP promotion may SHARE a
	 * function-claimed register instead of leaving it idle: a loop
	 * candidate may take register R when it has no interference edge with
	 * ANY current occupant of R (ranges provably never overlap). `pinned`
	 * holds the function's param claims (their prologue inits are
	 * unconditional — never shared). Cleared/restored alongside
	 * register_allocations; the inline-expansion path leaves it unset so
	 * in-body loops fall back to avoid-mode.
	 *
	 * `source_keys` (stage 3) maps each source name to EVERY key it owns in
	 * the allocator's renamed view — the plain name when uniquely declared,
	 * all `name@N` site keys when redeclared. Sharing must check edges for
	 * every candidate-key × occupant-key pair: occupants are bound by
	 * source name in the frame maps, while the adjacency is keyed by the
	 * renamed view — a plain-name lookup against a site-keyed name misses
	 * and would "share" over a live range (the mul_to corruption receipt).
	 */
	nir_alloc_shared?: {
		adj: Map<string, Set<string>>;
		pinned: Set<string>;
		source_keys: Map<string, string[]>;
	};
	/**
	 * aarch64-only (ASM_PLAN_3 tranche L): cross-statement access-staging
	 * pins. Straight-line windows of plain declares/assigns may keep a
	 * Buffer-accessor index sum and the receiver's data pointer in x10/x11
	 * (never homes, never call-protocol registers). `entries` maps a
	 * canonical key (index-sum terms / receiver path) to its pin — the code
	 * length at fill time and the written-names snapshot fence every
	 * consult (see access_staging.ts). `written` accumulates the names the
	 * window's statements have assigned; a pin dies when a name it reads is
	 * written after its fill. Undefined = no live window (tainted).
	 */
	access_pins?: {
		entries: Map<
			string,
			{
				key: string;
				reg: string;
				len: number;
				names: string[];
				snap: Set<string>;
			}
		>;
		written: Set<string>;
	};
	/**
	 * aarch64-only (ASM_PLAN_5): region-scoped pool claims. The plan
	 * publishes, per loop AST node, the pool registers whose function-wide
	 * occupants are dead throughout the loop's blocks (with the occupants
	 * the emitter must spill/reload around the body) and the loop's
	 * loop-invariant Buffer receiver paths. The while-dispatch bracket
	 * spills the displaced occupants, pre-derives each receiver's data
	 * pointer into its pin register before the loop header, and pre-seeds
	 * `buffer_data_cache` (via `region_preseed`, applied after the loop
	 * builder's snapshot-clear) — so in-loop accessor derivations emit
	 * nothing and the pointer is materialized once per LOOP. Undefined =
	 * no region plan for this function.
	 */
	nir_region_free?: Map<
		BaseNode,
		{
			pins: {
				reg: string;
				displaced: { name: string; key: string; type_name: string }[];
				dead: string[];
				/** Base-folded addressing (ASM_PLAN_6): scratch registers
				 *  preloaded with `reg + base*8` at bracket entry; the
				 *  accessor staging indexes matching `base + var` args with
				 *  the bare var. */
				folds?: { base: string; reg: string }[];
			}[];
			/** Region-scoped source variables (ASM_PLAN_5 tranche 5):
			 *  loop-contained hot int locals the plan assigns to the loop's
			 *  remaining free pool registers. The bracket binds each name
			 *  into `register_allocations` for the body (after the builder's
			 *  snapshot — the exit restore drops it) and round-trips the
			 *  displaced occupants exactly like a receiver pin. Site-keyed
			 *  vars (`key` set) install into `nir_site_allocs` instead and
			 *  bind at their declare sites. */
			vars?: {
				reg: string;
				name: string;
				key?: string;
				type_name: string;
				displaced: { name: string; key: string; type_name: string }[];
				dead: string[];
			}[];
			/** Loop inductions (ASM_PLAN_7 tranche 2): loop-carried scalars
			 *  the bracket pins into scratch registers — entry load before
			 *  the header, name bound for the body, final value stored back
			 *  after the loop. Plain uniquely-declared names only. */
			inds?: {
				reg: string;
				name: string;
				type_name: string;
				dead: string[];
			}[];
			receivers: { key: string; node: BaseNode }[];
			/** The plan's scratch-set scan verdict for this loop's region
			 *  (ASM_PLAN_7 tranche 3): the loop's emission provably never
			 *  touches x4–x8. When an emitter-side event refuses a planned
			 *  pin register (an enclosing bracket's hold — invisible to the
			 *  plan), the bracket may draw the receiver hoist from
			 *  NIR_SCRATCH_X under this verdict. */
			scratch_ok?: boolean;
		}
	>;
	/** Pending region pre-seed for the loop builder to apply after its
	 *  cache snapshot-clear (node identity checked). `vars` are the
	 *  region-scoped source-variable bindings to install after the
	 *  builder's snapshot: plain names go into `register_allocations`,
	 *  site-keyed ones into `nir_site_allocs` (bind at their declare
	 *  sites; the builder restores the table at bracket exit). `inds`
	 *  are the loop-induction bindings (plain names into
	 *  `register_allocations`; the exit store-back in region_pool_exit
	 *  publishes the final value). */
	region_preseed?: {
		node: BaseNode;
		entries: {
			key: string;
			reg: string;
			/** Base-fold registers for this pin: installed into
			 *  `buffer_fold_cache` (`key|base` → reg) with the cache
			 *  pre-seed. */
			folds?: { base: string; reg: string }[];
		}[];
		vars?: { name: string; reg: string; key?: string }[];
		inds?: { name: string; reg: string }[];
	};
	/**
	 * aarch64-only (ASM_PLAN_5): OPEN region-pin depth per register (data
	 * pointers materialized by open while-dispatch brackets). Loop promotion
	 * must never claim or share a register with nonzero depth — the
	 * interference adjacency cannot see the pin, so sharing a loop local
	 * onto one destroys the pin or the local (knucleotide count_seq
	 * receipt). Reference-counted: nested brackets may borrow the same
	 * register (stack discipline — inner exit restores the outer pin), so
	 * the refusal lifts only when the last bracket closes. Maintained by
	 * region_pool_enter/exit.
	 */
	region_pinned?: Map<string, number>;
	/**
	 * aarch64-only (ASM_PLAN_4 field-pair SLP): name → partner map for the
	 * adjacent-statement float pairs the loop-promotion planner allocated
	 * into LANE-PAIRED registers — `a` in dN (lane 0, scalar-visible) and
	 * `b` in vN.d[1] (the unnamed high lane; b is deliberately NOT
	 * register-promoted, its slot stays synced by the pair fuses). See
	 * slp_pair.ts for the soundness gates.
	 */
	slp_pair_hints?: Map<string, string>;
	/**
	 * aarch64-only (ASM_PLAN_4 field-pair SLP): v-registers hosting live
	 * pairs (vN whose high lane is b) — the float-tree temp allocator
	 * (d16+) must skip their low halves: a scalar write to dM ZEROES the
	 * upper half of vM, which would silently destroy b.
	 */
	slp_pair_vregs?: Set<string>;
	/**
	 * aarch64-only (ASM_PLAN_3 tranche L): `_param_N` hoisted argument
	 * temps whose declaration is skipped and whose initializer tree is
	 * re-emitted at the single read (the accessor paths consult this).
	 * Repopulated per statement by emit_allocations; restored by
	 * build_block_node around each statement.
	 */
	forwarded_param_inits?: Map<string, BaseNode>;
	/**
	 * aarch64-only (ASM_PLAN_3 tranche M): per-statement `_param_N`
	 * initializers rewritten by the loop value-numbering pass — the
	 * checker-hoisted temp's chain had its invariant prefix hoisted to a
	 * `_vn_N` preheader declare, so the temp's slot must never be written
	 * (emit_allocations skips it and feeds the rewritten tree to the
	 * accessor's staging path instead). Keyed by the owning statement's
	 * AST node; set/cleared by the pass around each body build.
	 */
	vn_param_inits?: Map<BaseNode, Map<string, BaseNode>>;
	/**
	 * aarch64-only (ASM_PLAN_6 base-fold): `"receiverKey|baseName"` → the
	 * scratch register holding `data_ptr + base*8` for the bracketed loop's
	 * pinned receiver. A `load_int`/`store_int` whose index argument is
	 * `base + var` (both plain names) with a hit here emits the strided
	 * access straight off the folded register with the bare var — no index
	 * staging, no base read per iteration. Installed by build_while_loop_node
	 * from the region pre-seed (plan-assigned scratch registers); snapshotted
	 * and restored with buffer_data_cache at every loop/branch boundary, and
	 * cleared at inline/for boundaries (the fold register has no claim
	 * there).
	 */
	buffer_fold_cache?: Map<string, string>;
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
	/**
	 * Fixed-array element-address pipeline (ASM_PLAN_3 tranche A): maps
	 * "<array>@<index>" to the callee-saved register holding `base +
	 * index*stride` for a fixed-size array of structs. Same bracketing and
	 * invalidation discipline as buffer_data_cache (loop/if/switch/match
	 * snapshots, assignment and call invalidation).
	 */
	array_ptr_cache?: Map<string, string>;
	/**
	 * Consume-once: set by the fixed-array `.at()` fast path when the
	 * element address was produced into (or reads from) a pinned cache
	 * register. Consumed by the immediately-following method-access field
	 * hop in build_access_field (single `ldr [reg, #off]`, float fields
	 * straight into d0) and by deferred_field_base_reg in
	 * build_assignment_node. Cleared at every build_access_node entry.
	 */
	at_addr_reg?: string;
	/**
	 * Canonical-IR stage 2 (ASM_PLAN phase 4): the NIR statement list driving
	 * emission for the block currently being built, index-aligned 1:1 with
	 * `ast`. Statement dispatch verifies `ast[i]` identity before consuming,
	 * so any nested block build that doesn't own the cursor (inline bodies,
	 * delegated for/switch/match branches, method bodies…) safely falls back
	 * to the AST walk. Undefined = pure AST walk. Shared by BOTH backends —
	 * each installs it around its own function-body builds.
	 */
	nir_emit_ctx?: import("../nir/emit_ctx.ts").NirEmitCtx;
	platform: string;
	label_counter?: number;
	/**
	 * Counter for generating unique spawn-site IDs (struct + trampoline names).
	 */
	spawn_counter?: number;
	/**
	 * True when the build emitted the fiber runtime (a fiber spawn, or a
	 * Fiber static like yield/is_fiber). main drains pending fibers before
	 * the audit check so deferred cooperative work completes (and frees)
	 * deterministically — see build_fiber_spawn.
	 */
	used_fibers?: boolean;
	/**
	 * True once the pool runtime text (POOL_HEADER / POOL_HEADER_C) has been
	 * appended to this build's header/companion sink. Content checks are
	 * unreliable: a nested-function build clears status.headers mid-build, so
	 * a marker-based guard would append a second copy.
	 */
	pool_runtime_emitted?: boolean;
	/** True once the fiber runtime text (FIBER_HEADER / FIBER_HEADER_C) has been appended. */
	fiber_runtime_emitted?: boolean;
	/**
	 * C split builds ("system" emit mode): the concurrency runtime text
	 * globalized to external linkage, accumulated by
	 * ensure_concurrency_runtime and flushed to file scope at the top of the
	 * system TU's code by build(). The user TU declares the runtime instead
	 * (via system.h) and links against this one copy.
	 */
	c_runtime_defs?: string;
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
			cap_off?: number;
			deadline_off?: number;
		}
	>;
	/**
	 * Tracks which struct body typedefs have already been emitted to avoid
	 * duplicate definitions when nested structs are also emitted at root level.
	 */
	emitted_struct_bodies?: Set<string>;
	/**
	 * Tracks which enum typedefs have already been emitted, so an enum pulled
	 * to root scope as a dependency of a monomorphized enum (see
	 * `emit_enum_in_order`) is not emitted a second time by
	 * `emit_nested_declarations` when the enclosing function body is built.
	 */
	emitted_enums?: Set<string>;
	/**
	 * Tracks which bitset typedefs have already been emitted, mirroring
	 * `emitted_enums` for the same dependency-pulling idempotency.
	 */
	emitted_bitsets?: Set<string>;
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
	 * aarch64-only (ASM_PLAN_2 tranche D addendum): body-declared loop
	 * locals whose stack slots were pre-allocated by `promote_loop_locals`
	 * BEFORE the body builds, so they can be register-promoted (their slot
	 * would otherwise not exist until the declare builds — after promotion).
	 * Maps declare name → slot size. The declare build consults this map and
	 * REUSES the pre-allocated offset instead of allocating a second slot
	 * (a second slot left the promotion's entry load / exit store-back
	 * pointing at a slot nothing else read or wrote — the reverted naive
	 * attempt's uninitialized-memory bug). Populated per loop; the loop
	 * builders snapshot/restore it around the body build.
	 */
	preallocated_decl_slots?: Map<string, number>;
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
	/**
	 * aarch64-only: trait default-method bodies (`<Trait>_<method>`) that have
	 * already been emitted. The aarch64 struct builder walks each conforming
	 * struct's traits and would otherwise re-emit the same trait-level default
	 * body once per conformer; this set deduplicates so the symbol is defined
	 * exactly once (mirroring the C backend, which emits trait defaults from
	 * build_trait_node, called once per trait).
	 */
	emitted_trait_funcs?: Set<string>;
}
