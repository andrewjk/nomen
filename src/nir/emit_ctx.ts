import type BaseNode from "../nodes/BaseNode.ts";
import type { NirStmt } from "./nir.ts";

/**
 * Emission cursor (phase 4 canonical-IR stage 2): published by a function
 * build when its whole body lowered cleanly to NIR (`unknown_kinds` empty).
 *
 * `stmts` is index-aligned 1:1 with the AST statement list `ast` (from_ast is
 * a faithful lowering). Consumers identity-check `ctx.ast` against the list
 * they are iterating, so a nested block build that does not own the list
 * (inline method bodies, delegated branch bodies, spawn/async bodies…)
 * structurally cannot consume another block's cursor.
 */
export interface NirEmitCtx {
	/** Lowered statements, index-aligned with `ast` (from_ast is 1:1). */
	stmts: readonly NirStmt[];
	/** The exact AST statement list this ctx drives (identity-checked). */
	ast: readonly BaseNode[];
}
