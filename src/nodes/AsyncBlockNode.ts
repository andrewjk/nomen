import BaseNode from "./BaseNode.ts";
import type BlockNode from "./BlockNode.ts";

/**
 * `async { ... }` — a nursery block.
 *
 * Spawns inside the block are tracked; the block cannot exit until all
 * spawned tasks have finished (implicit join at scope exit). This is the
 * structured-concurrency primitive — see ASYNC.md.
 *
 * Optional `timeout` (milliseconds): if set, all tasks in the nursery are
 * cancelled when the deadline expires. The nursery join loop uses timed
 * waits so it can enforce the deadline.
 *
 * Optional `mode`: `"all"` (default — wait for every spawned task) or
 * `"race"` — wait for the first task to complete (or the deadline), then
 * cancel the rest.
 */
export type AsyncMode = "all" | "race";

export default class AsyncBlockNode extends BaseNode implements BlockNode {
	statements: BaseNode[];
	timeout?: BaseNode;
	mode?: AsyncMode;
	/**
	 * The user-chosen name for this nursery, e.g. `async nursery { }` or
	 * `async pool = Nursery(timeout: 2000) { }`. When set, a `Nursery`-typed
	 * variable of this name is in scope inside the block — it is the
	 * capability passed to functions that spawn into this nursery (the escape
	 * hatch) and the receiver of `name.spawn(fn(args))`. When unset (`async { }`),
	 * only lexical `spawn` is usable. See ASYNC.md.
	 */
	nursery_name?: string;

	constructor(start: number, statements: BaseNode[] = [], timeout?: BaseNode) {
		super("async_block", start);
		this.statements = statements;
		this.timeout = timeout;
	}
}
