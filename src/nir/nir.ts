import type BaseNode from "../nodes/BaseNode.ts";
import type Type from "../nodes/Type.ts";

/**
 * NIR — the canonical per-function IR (ASM_PLAN phase 4).
 *
 * Lowered FROM the checked AST (`from_ast.ts`) so that every backend-facing
 * analysis (whole-function register allocation today; liveness, vectorization
 * and future lowering passes later) consumes one typed structure instead of
 * re-walking raw parse nodes with duck-typed field guesses — the class of
 * blindness this effort exists to eliminate.
 *
 * Design constraints, deliberately:
 *
 * - STRUCTURED, not flat: the source language has no goto, so a statement
 *   tree IS the control-flow graph. Loop nesting depth for hotness weighting
 *   and future dominance queries fall out of the tree directly; a flattening
 *   pass to basic blocks can come later without changing the shape callers
 *   see.
 * - CLOSED and EXHAUSTIVE: every variant is a tagged literal type. `from_ast`
 *   lowers unknown/unmodeled AST node types into `other` carry-variants and
 *   RECORDS them in a coverage set, so test suites can assert full coverage
 *   of the NodeType union instead of silently dropping constructs (the
 *   pre-NIR scans skipped if-branches, method-call arguments and switch/match
 *   arms exactly that way). Consumers switch exhaustively — a new variant is
 *   a compile error at every use site until handled.
 * - FACT-CARRYING: facts the backends need are extracted once during
 *   lowering and ride the IR explicitly — ref/swap argument indices on calls,
 *   receiver positions on paths (address-take marks), scalar modifier flags
 *   on declarations. Analyses never guess again.
 * - HONEST ESCAPES: statements/expressions with no modeling surface as
 *   explicit `other_*`/`opaque` variants carrying the original node, recorded
 *   in a coverage set so tests keep them empty over real code. Lowering is
 *   TOTAL over the checked AST as of the fallback-retirement tranche: the
 *   remaining `opaque` producers are type declarations (struct/class/trait/
 *   enum/bitset/extend), which are hoisted/skipped by the block loop and
 *   never dispatched, so they lower to `opaque` WITHOUT recording. A new
 *   unknown kind is a tripwire (`build_function_node` throws), not a silent
 *   fallback.
 */

/** A variable read inside an expression tree, as reported by traffic.ts. */
export interface NirRead {
	name: string;
	/** The identifier node itself (for position-specific decisions). */
	node: BaseNode;
	/**
	 * True when the identifier sits in a RECEIVER position — the value's
	 * address can escape through member access or swap marshalling.
	 */
	receiver: boolean;
}

export interface NirCallFacts {
	args: NirExpr[];
	/** Indices into `args` passed to `ref` parameters (slot may be written). */
	ref_arg_indices: number[];
	/** Extra swapee expressions exchanged by built-in swap marshalling. */
	swap_exprs: NirExpr[];
}

export type NirExpr =
	| { readonly kind: "leaf"; readonly node: BaseNode; readonly name: string | null }
	| {
			readonly kind: "binary";
			readonly node: BaseNode;
			readonly left: NirExpr;
			readonly right: NirExpr;
	  }
	| { readonly kind: "wrap"; readonly node: BaseNode; readonly inner: NirExpr | null }
	| {
			readonly kind: "call";
			readonly node: BaseNode;
			readonly callee: string;
			readonly facts: NirCallFacts;
	  }
	| {
			readonly kind: "method_call";
			readonly node: BaseNode;
			readonly receiver: NirExpr;
			readonly name: string;
			readonly facts: NirCallFacts;
	  }
	| {
			readonly kind: "path";
			readonly node: BaseNode;
			readonly receiver: NirExpr;
			readonly steps: NirPathStep[];
	  }
	/** Value-position control flow (`var k = match len { … }`, `return if c {
	 *  a } else { b }`). The backend emits these through the SAME join-slot
	 *  builders the AST walk used (the lowered expr routes `build_node` to
	 *  them); the arms ride the IR so liveness/vectorization see the traffic. */
	| {
			readonly kind: "flow";
			readonly node: BaseNode;
			readonly scrutinee: NirExpr | null;
			readonly arms: readonly NirArm[];
			readonly otherwise: NirStmt[] | null;
	  }
	/** Value-position `spawn` (`var t = spawn f(x)`) — the call rides whole
	 *  so liveness folds its argument reads; traffic deliberately does not
	 *  count them (promotion-input parity — see FOLLOWUP.md). */
	| { readonly kind: "spawn"; readonly node: BaseNode; readonly call: NirExpr }
	| { readonly kind: "other"; readonly node: BaseNode };

/** One arm of a match/switch/if: condition (null = always-taken default) + branch statements. */
export interface NirArm {
	readonly condition: NirExpr | null;
	readonly branch: NirStmt[];
}

/** One member hop on an access path: `.field` reads or trailing method tail… */
export interface NirPathStep {
	readonly name: string;
	readonly node: BaseNode;
}

/** Modifier flags a declaration carries — promotion eligibility inputs. */
export interface NirDeclModifiers {
	readonly is_array?: boolean;
	readonly is_view?: boolean;
	readonly is_ref?: boolean;
	readonly is_nullable?: boolean;
}

export interface NirDeclareInfo {
	readonly name: string;
	readonly type: Type;
	readonly modifiers: NirDeclModifiers;
	readonly init: NirExpr | null;
	/** Replacement value written back into a moved-out source (`var X b =
	 *  mov obj.field swap <rep>`); null when the declaration has no swap. */
	readonly swap: NirExpr | null;
	readonly node: BaseNode;
}

interface NirStmtBase {
	/** Original AST statement this IR statement lowered from. */
	readonly node: BaseNode;
}

export type NirStmt =
	| (NirStmtBase & { readonly kind: "declare"; readonly decl: NirDeclareInfo })
	| (NirStmtBase & {
			readonly kind: "assign";
			readonly target: NirExpr;
			readonly rhs: NirExpr;
			/** Compound operator (`+` for `x += …`) — the target's OLD value is
			 *  read exactly when this is set. */
			readonly operator: string | null;
			/** Replacement value exchanged by swap marshalling (`a = b swap c`)
			 *  — built in VALUE position, then stored into the rhs source. */
			readonly swap: NirExpr | null;
	  })
	| (NirStmtBase & { readonly kind: "eval"; readonly expr: NirExpr })
	| (NirStmtBase & {
			readonly kind: "if";
			readonly cond: NirExpr;
			readonly then_branch: NirStmt[];
			readonly else_branch: NirStmt[];
	  })
	| (NirStmtBase & {
			readonly kind: "while";
			readonly cond: NirExpr;
			readonly body: NirStmt[];
			readonly update: NirStmt | null;
	  })
	| (NirStmtBase & {
			readonly kind: "for";
			readonly item_name: string;
			readonly list: NirExpr | null;
			readonly body: NirStmt[];
			readonly update: NirStmt | null;
	  })
	| (NirStmtBase & {
			readonly kind: "switch_match";
			readonly scrutinee: NirExpr | null;
			readonly arms: readonly NirArm[];
			readonly otherwise: NirStmt[] | null;
	  })
	| (NirStmtBase & { readonly kind: "return"; readonly value: NirExpr | null })
	| (NirStmtBase & { readonly kind: "break" })
	| (NirStmtBase & { readonly kind: "continue" })
	| (NirStmtBase & { readonly kind: "exit"; readonly message: string | null })
	| (NirStmtBase & { readonly kind: "raw"; readonly code: string })
	| (NirStmtBase & { readonly kind: "spawn"; readonly call: NirExpr })
	| (NirStmtBase & { readonly kind: "async_block"; readonly body: NirStmt[] })
	| (NirStmtBase & {
			readonly kind: "nested_func";
			readonly name: string;
			readonly label_name: string | undefined;
			readonly params: readonly { readonly name: string; readonly type: Type }[];
			readonly body: NirStmt[];
	  })
	| (NirStmtBase & {
			readonly kind: "anon_struct";
			readonly fields: readonly { readonly expr: NirExpr }[];
	  })
	| (NirStmtBase & { readonly kind: "opaque" });

/**
 * A function lowered to NIR. `body` statements appear in source order;
 * nested functions lower inline (their declarations participate in their
 * ENCLOSING function's analyses, matching the conservative behavior of the
 * original scans).
 */
export interface NirFunction {
	readonly name: string;
	readonly label_name: string | undefined;
	readonly params: readonly {
		readonly name: string;
		readonly type: Type;
		readonly is_variadic?: boolean;
	}[];
	readonly body: NirStmt[];
	/** AST node kinds that had no NIR mapping while lowering (must stay empty). */
	readonly unknown_kinds: ReadonlySet<string>;
}
