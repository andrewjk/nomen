import BaseNode from "./BaseNode.ts";
import type BlockNode from "./BlockNode.ts";

/**
 * A bare nested block statement (`{ ... }`) inside a function body: a
 * plain lexical scope. Deterministic destruction runs at the block's end —
 * the one-zero-cost way to release a mv value before the enclosing function
 * ends (the honest form of the `if true { … }` workaround).
 */
export default class NestedBlockNode extends BaseNode implements BlockNode {
	statements: BaseNode[];

	constructor(start: number, statements?: BaseNode[]) {
		super("block", start);
		this.statements = statements || [];
	}
}
