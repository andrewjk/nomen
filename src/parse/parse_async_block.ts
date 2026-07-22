import type { AsyncMode } from "../nodes/AsyncBlockNode.ts";
import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

/**
 * Parse the `(key: value, ...)` options shared by `async(opts) { }` and
 * `async name = Nursery(opts) { }`. Mutates `timeout`/`mode` from the closure.
 */
function parse_nursery_opts(
	status: ParseStatus,
	timeout: (v: BaseNode) => void,
	mode: (m: AsyncMode) => void,
) {
	while (peek_current(status) !== ")" && peek_current(status) !== "") {
		const key = consume(status);
		if (!accept(":", status)) break;
		const value = parse_expression(status);
		if (key === "timeout") {
			timeout(value);
		} else if (key === "mode" && value && value.node_type === "value") {
			const v = (value as ValueNode).value;
			if (v === "race" || v === "all") mode(v);
		}
		if (!accept(",", status)) break;
	}
}

export default function parse_async_block(status: ParseStatus) {
	const start = get_index(status);
	accept("async", status);

	let timeout: BaseNode | undefined;
	let mode: AsyncMode | undefined;
	let nursery_name: string | undefined;

	const next = peek_current(status);
	if (next === "(") {
		// Backward-compatible unnamed form: async(timeout: N, mode: race) { ... }
		accept("(", status);
		parse_nursery_opts(
			status,
			(v) => (timeout = v),
			(m) => (mode = m),
		);
		expect(")", status);
	} else if (next !== "{" && next !== "") {
		// Named form: async <name> { ... }  or  async <name> = Nursery(opts) { ... }
		nursery_name = consume(status);
		if (accept("=", status)) {
			// Expect `Nursery` then `( opts )`.
			consume(status); // "Nursery"
			expect("(", status);
			parse_nursery_opts(
				status,
				(v) => (timeout = v),
				(m) => (mode = m),
			);
			expect(")", status);
		}
	}

	if (expect("{", status)) {
		const block = new AsyncBlockNode(start, [], timeout);
		block.mode = mode;
		block.nursery_name = nursery_name;
		status.stack.push(block);
		parse_statement(status);
		expect("}", status);
		status.stack.pop();

		add_to_parent(block, "Async block", status);
	}
}
