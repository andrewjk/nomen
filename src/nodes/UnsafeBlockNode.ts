import BaseNode from "./BaseNode.ts";

/**
 * An `unsafe { ... }` block: a scoped group of statements in which the
 * pointer operations (`ptr T` values, `p[i]` indexing, integer↔pointer
 * casts) become legal. Library-only: the parser rejects `unsafe` outside
 * the System library source, and the checker independently rejects pointer
 * operations that are not lexically inside an unsafe block or an
 * unsafe-declared function.
 */
export default class UnsafeBlockNode extends BaseNode {
	node_type = "unsafe" as const;
	statements: BaseNode[];

	constructor(start: number, statements: BaseNode[]) {
		super("unsafe", start);
		this.statements = statements;
	}
}
