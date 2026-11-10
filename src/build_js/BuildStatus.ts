import type BaseNode from "../nodes/BaseNode.ts";
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
	/** User enum declarations (v1: collected, not yet emitted). */
	enums: EnumNode[];
	errors: CompileError[];
}

export function create_status(root: BaseNode): BuildStatus {
	return { root, code: "", indent: 0, structs: [], enums: [], errors: [] };
}
