import BaseNode from "./BaseNode.ts";
import FunctionCallNode from "./FunctionCallNode.ts";

/**
 * `spawn <call>` — run a function call on a thread, fire-and-forget for v1.
 *
 * The wrapped FunctionCallNode is checked and built like a regular call, but
 * the build phase emits a per-call-site arg-packing struct + trampoline and
 * submits to the thread pool instead of executing inline.
 *
 * See ASYNC.md for the design.
 */
export default class SpawnNode extends BaseNode {
	call: FunctionCallNode;

	constructor(start: number, call: FunctionCallNode) {
		super("spawn", start);
		this.call = call;
	}
}
