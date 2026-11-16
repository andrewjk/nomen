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
	 * Base directory for `#embed_file("relative/path")` — the package root
	 * (the directory containing package.jsonc), or the entry file's folder
	 * when no package root exists. Undefined when no file path was supplied
	 * to parse: `#embed_file` then resolves against the process CWD.
	 */
	embed_root?: string;
	/**
	 * Errors that have been encountered
	 */
	errors: CompileError[];
	/**
	 * Token-value mutation journal for speculative parses (only
	 * `try_parse_generic_args` sets it). `expect_close_angle` peels `>>` →
	 * `>` IN PLACE; a speculative attempt that backtracks must undo those
	 * peels. When the journal is present, every peel records the token
	 * index and its pre-peel value, so undoing touches only the tokens the
	 * attempt actually mutated instead of snapshotting the whole token
	 * stream per attempt (which allocated an entry per token per attempt —
	 * quadratic on comparison-heavy sources).
	 */
	value_journal?: { idx: number; value: string }[] | null;
	/**
	 * Attributes collected from a leading `@Name("x"), @Type("t")` list
	 * (stage 3), awaiting the declaration they precede. Set by
	 * parse_statement's `@` case; consumed (and cleared) by
	 * take_attributes at the struct/field/function attach sites.
	 */
	pending_attributes?: import("../types/AttributeMeta.ts").default[];
}
