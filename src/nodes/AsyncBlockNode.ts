import BaseNode from "./BaseNode.ts";
import type BlockNode from "./BlockNode.ts";

/**
 * `async { ... }` — a nursery block.
 *
 * Spawns inside the block are tracked; the block cannot exit until all
 * spawned tasks have finished (implicit join at scope exit). This is the
 * structured-concurrency primitive — see ASYNC.md.
 */
export default class AsyncBlockNode extends BaseNode implements BlockNode {
	statements: BaseNode[];

	constructor(start: number, statements: BaseNode[] = []) {
		super("async_block", start);
		this.statements = statements;
	}
}
