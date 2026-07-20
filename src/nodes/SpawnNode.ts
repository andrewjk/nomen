import BaseNode from "./BaseNode.ts";
import FunctionCallNode from "./FunctionCallNode.ts";
import Type from "./Type.ts";

/**
 * `spawn <call>` — run a function call on a thread.
 *
 * The wrapped FunctionCallNode is checked and built like a regular call, but
 * the build phase emits a per-call-site arg-packing struct + trampoline and
 * submits to the thread pool instead of executing inline.
 *
 * - `function_return_type`: the wrapped function's return type (captured
 *   during check, before the SpawnNode's overall type is overwritten to
 *   `Task`). Used by the build phase to decide whether the trampoline should
 *   capture a result.
 * - `call.type` is overwritten to `Task` during check so the spawn expression
 *   as a whole has type Task.
 *
 * See ASYNC.md for the design.
 */
export default class SpawnNode extends BaseNode {
	call: FunctionCallNode;
	function_return_type?: Type;

	constructor(start: number, call: FunctionCallNode) {
		super("spawn", start);
		this.call = call;
	}
}

