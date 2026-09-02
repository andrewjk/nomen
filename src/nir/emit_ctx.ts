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
import type { ForwardUse } from "../build_aarch64/forward.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type { NirStmt } from "./nir.ts";

export interface NirEmitCtx {
	/** Lowered statements, index-aligned with `ast` (from_ast is 1:1). */
	stmts: readonly NirStmt[];
	/** The exact AST statement list this ctx drives (identity-checked). */
	ast: readonly BaseNode[];
	/**
	 * Names with zero reads that no ref marshalling can touch — computed by
	 * the stage-4 forwarding pass (build_aarch64/forward.ts) when it ran.
	 * The cset fuse consults this to skip the dead cmp/cset/store tail of a
	 * write-only flag. Absent when the pass is off.
	 */
	write_only?: ReadonlySet<string>;
	/**
	 * Single-use forward plans keyed by the use statement's AST node — the
	 * emitter applies each as a one-statement AST mutation (apply → build →
	 * restore) via apply_forward_use. Absent when the pass is off.
	 */
	use_sites?: ReadonlyMap<BaseNode, ForwardUse>;
	/**
	 * AST nodes of declares whose initializer a forward consumed — the
	 * emitter emits nothing for them (the use site re-emits the init).
	 */
	forward_defs?: ReadonlySet<BaseNode>;
}
