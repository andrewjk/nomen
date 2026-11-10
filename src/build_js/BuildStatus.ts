import type BaseNode from "../nodes/BaseNode.ts";
import type BitsetNode from "../nodes/BitsetNode.ts";
import type EnumNode from "../nodes/EnumNode.ts";
import type StructNode from "../nodes/StructNode.ts";
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
	/** User enum declarations (values are inline objects; this table is how
	 *  case construction and match tags resolve). */
	enums: EnumNode[];
	/** User bitset declarations (cases are single-bit bigint constants). */
	bitsets: BitsetNode[];
	/** Monotonic counter for generated temp names (`__match_0`, …). */
	temp: number;
	/** The CURRENT function's `ref` parameter names (boxed in JS); the
	 *  assignment builder writes through the box. */
	ref_params?: Set<string>;
	errors: CompileError[];
}

export function create_status(root: BaseNode): BuildStatus {
	return {
		root,
		code: "",
		indent: 0,
		structs: [],
		enums: [],
		bitsets: [],
		temp: 0,
		errors: [],
	};
}
