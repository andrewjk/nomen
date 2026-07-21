import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import SpawnNode from "../nodes/SpawnNode.ts";
import parse_function_call_parameter from "./parse_function_call_parameter.ts";
import type ParseStatus from "./ParseStatus.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

/**
 * Parse `spawn <call>` and return the SpawnNode. Caller decides whether to
 * add the node to the parent (statement form) or use it as an expression.
 */
export function parse_spawn_node(status: ParseStatus): SpawnNode {
	const start = get_index(status);
	consume(status); // consume "spawn"

	const name = consume(status);
	const call = new FunctionCallNode(start, name);

	expect("(", status);
	if (peek_current(status) !== ")") {
		parse_function_call_parameter(call, status);
	}
	expect(")", status);

	return new SpawnNode(start, call);
}

export default function parse_spawn(status: ParseStatus) {
	const node = parse_spawn_node(status);
	node.is_statement = true;
	add_to_parent(node, "Spawn expression", status);
}
