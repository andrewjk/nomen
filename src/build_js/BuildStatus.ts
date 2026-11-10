import type BaseNode from "../nodes/BaseNode.ts";
import type BitsetNode from "../nodes/BitsetNode.ts";
import type EnumNode from "../nodes/EnumNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import type TraitNode from "../nodes/TraitNode.ts";
import type CompileError from "../types/CompileError.ts";

/** Build state for the JS backend (see src/build_js/build_js.ts). The C
 *  backend's BuildStatus carries memory/ownership bookkeeping the JS backend
 *  does not need — JS values are garbage-collected, so `mv`/auto-free/audit
 *  concerns vanish; only the emitted text and the collected type table
 *  matter. */
export default interface BuildStatus {
	root: BaseNode;
	/** Emitted JavaScript. */
	code: string;
	/** Current indentation depth (tabs). */
	indent: number;
	/** User struct declarations (library types are handled by the runtime). */
	structs: StructNode[];
	/** System-library struct declarations: lowered on demand when a program
	 *  uses code the JS runtime does not natively model (see library_queue). */
	library_structs: StructNode[];
	/** User enum declarations (values are inline objects; this table is how
	 *  case construction and match tags resolve). */
	enums: EnumNode[];
	/** User bitset declarations (cases are single-bit bigint constants). */
	bitsets: BitsetNode[];
	/** Trait declarations: a call on a trait-typed receiver dispatches on the
	 *  value's concrete struct at runtime (JS has no static devirtualization
	 *  for a trait-typed parameter). */
	traits: TraitNode[];
	/** Monotonic counter for generated temp names (`__match_0`, …). */
	temp: number;
	/** The CURRENT function's `ref` parameter names (boxed in JS); the
	 *  assignment builder writes through the box. */
	ref_params?: Set<string>;
	/** Checker-hoisted temps by name (`_param_0` → its initializer). The JS
	 *  backend INLINES these at each reference instead of hoisting a `const`
	 *  to the statement boundary: evaluation order and loop-fresh values then
	 *  match the native backends (which assign the temp at the use site). */
	allocations?: Map<string, BaseNode>;
	/** Recursion guard while inlining an allocation. */
	inlining?: Set<string>;
	/** On-demand library lowering: emitted code, pending declarations, and the
	 *  set of declarations already emitted. */
	library_code: string;
	library_method_queue: { struct: StructNode; func: FunctionNode }[];
	library_init_queue: StructNode[];
	library_function_queue: FunctionNode[];
	emitted_library: Set<unknown>;
	errors: CompileError[];
}

export function create_status(root: BaseNode): BuildStatus {
	return {
		root,
		code: "",
		indent: 0,
		structs: [],
		library_structs: [],
		enums: [],
		bitsets: [],
		traits: [],
		temp: 0,
		library_code: "",
		library_method_queue: [],
		library_init_queue: [],
		library_function_queue: [],
		emitted_library: new Set(),
		errors: [],
	};
}
