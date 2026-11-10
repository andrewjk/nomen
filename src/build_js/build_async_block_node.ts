import type AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import { capture_body, emit, expr, stmt } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { js_name } from "./names.ts";

/**
 * `async { ... }` — the JS backend runs the nursery INLINE, in source order.
 *
 * Concurrency is omitted rather than emulated: every `Thread(...).start()` /
 * `Fiber(...).start()` / `nursery.start(...)` inside the block runs its task
 * synchronously before returning, so the implicit join at the closing brace is
 * already satisfied. A named nursery (`async pool { ... }`) becomes a plain
 * object that `pool.start(Thread(...))` accepts.
 */
export default function build_async_block_node(node: AsyncBlockNode, status: BuildStatus): void {
	emit(status, "{");
	status.indent += 1;
	build_nursery(node, status);
	// The deadline has no meaning when every task is already complete, but
	// its expression can have side effects (the native form evaluates it).
	if (node.timeout) emit(status, `${expr(node.timeout, status)};`);
	for (const statement of node.statements) stmt(statement, status);
	status.indent -= 1;
	emit(status, "}");
}

/** The value form of `async { ... }` (rare, but the checker can wrap one in a
 *  `let`): an IIFE that runs the block and yields `undefined`. */
export function build_async_block_expression(node: AsyncBlockNode, status: BuildStatus): string {
	const body = capture_body(status, () => {
		build_nursery(node, status);
		if (node.timeout) emit(status, `${expr(node.timeout, status)};`);
		for (const statement of node.statements) stmt(statement, status);
	});
	return `(() => {\n${body}${"\t".repeat(status.indent)}})()`;
}

function build_nursery(node: AsyncBlockNode, status: BuildStatus): void {
	if (!node.nursery_name) return;
	// The checker registers the nursery as a value; the build phase owns its
	// storage (the native backends emit a `Nursery` local here too).
	emit(status, `let ${js_name(node.nursery_name)} = {};`);
}
