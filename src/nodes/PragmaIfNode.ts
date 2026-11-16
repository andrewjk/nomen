import BaseNode from "./BaseNode.ts";
import type BlockNode from "./BlockNode.ts";

/**
 * One arm of a PragmaIfNode: `#if <condition>` / `#elif <condition>` /
 * `#else`. `condition` is null for the `#else` arm (always matches when
 * reached).
 */
export interface PragmaBranch {
	condition: BaseNode | null;
	block: BlockNode;
}

/**
 * A compile-time conditional — `#if META.arch == "c" { ... }` — docs/
 * COMPTIME_PLAN_2.md stage 1. Parsed anywhere a statement or declaration
 * is legal, but never checked or built: the checker folds it before
 * checking (fold_pragma_ifs in src/check/utils/pragma.ts), splicing the
 * first branch whose condition holds into the parent statement list and
 * deleting the rest. Only one arm survives and its statements splice as
 * the original nodes (no clones), so diagnostics keep pointing at real
 * source locations.
 *
 * `statements` is a PARSE-TIME collector only: while an arm's `{ ... }`
 * is being parsed the pragma itself sits on the stack (it must, so the
 * parser's parent-type attach switches accept declarations inside the
 * arm), and arm statements land here. When the arm's `}` closes, the
 * collector moves into that arm's block and resets for the next one. It
 * is always empty after parsing.
 */
export default class PragmaIfNode extends BaseNode {
	branches: PragmaBranch[];

	/** Parse-time arm collector — see the class doc. */
	statements: BaseNode[];

	constructor(start: number, branches: PragmaBranch[] = []) {
		super("pragma_if", start);
		this.branches = branches;
		this.statements = [];
	}
}
