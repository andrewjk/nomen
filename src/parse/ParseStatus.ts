import type { Library } from "../lib.ts";
import BaseNode from "../nodes/BaseNode.ts";
import type CompileError from "../types/CompileError.ts";
import type Token from "../types/Token.ts";

export default interface ParseStatus {
	/**
	 * Tokens extracted from source code
	 */
	tokens: Token[];
	/**
	 * The current token index
	 */
	i: number;
	/**
	 * The current node
	 */
	stack: BaseNode[];
	/**
	 * The current namespace
	 */
	namespace: string;
	/**
	 * Namespace-qualified paths seen in the source (`System::Controls::Button`),
	 * recorded for post-parse validation against the library namespace index.
	 */
	qualified_paths: { segments: string[]; start: number }[];
	/**
	 * The library linked into this compilation, if any. Present so import
	 * statements can validate their paths against the library's file layout.
	 */
	library?: Library;
	/**
	 * Source offset at which the appended System library source begins
	 * (i.e. the end of the user's own source). `unsafe` declarations and
	 * blocks — and `raw` `#arch:` blocks — are only accepted in tokens at or
	 * beyond this offset: the lockdown that keeps raw pointer manipulation
	 * library-only. Undefined when no library is linked: they are then
	 * illegal everywhere.
	 */
	unsafe_boundary?: number;
	/**
	 * Compiler-machinery escape (tests only, never set by the CLI): accept
	 * `raw` blocks in the user region. The raw-block splicing tests exercise
	 * the machinery on hand-written user-shaped programs; production builds
	 * never set this, so user code cannot reach raw pointer manipulation.
	 */
	allow_user_raw?: boolean;
	/**
	 * Errors that have been encountered
	 */
	errors: CompileError[];
}
