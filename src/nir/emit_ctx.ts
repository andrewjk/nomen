import type BaseNode from "../nodes/BaseNode.ts";
import type { NirStmt } from "./nir.ts";

/**
 * Emission cursor (phase 4 canonical-IR stage 2): published for EVERY
 * function-like body build — lowering is total over the checked AST, and the
 * whole-function AST fallback is retired (a residual unknown kind is a
 * tripwire throw in build_function_node / the body-cursor helpers).
 *
 * `stmts` is index-aligned 1:1 with the AST statement list `ast` (from_ast is
 * a faithful lowering). Consumers identity-check `ctx.ast` against the list
 * they are iterating, so a nested block build that does not own the list
 * (synthetic statement lists like constructor fragments, top-level-scope
 * emission…) structurally cannot consume another block's cursor.
 */
export interface NirEmitCtx {
	/** Lowered statements, index-aligned with `ast` (from_ast is 1:1). */
	stmts: readonly NirStmt[];
	/** The exact AST statement list this ctx drives (identity-checked). */
	ast: readonly BaseNode[];
}
