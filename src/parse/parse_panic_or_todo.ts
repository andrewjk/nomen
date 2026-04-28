import add_error from "../add_error.ts";
import { is_returning_node } from "../nodes/check_node_type.ts";
import PanicNode from "../nodes/PanicNode.ts";
import type ReturningNode from "../nodes/ReturningNode.ts";
import TodoNode from "../nodes/TodoNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_panic_or_todo(name: "panic" | "todo", status: ParseStatus) {
	const description = name.substring(0, 1).toUpperCase() + name.substring(1);

	const node_start = get_index(status);
	accept(name, status);

	const message_start = get_index(status);
	// Allow optional parentheses around the message
	accept("(", status);
	let message = peek_current(status);
	if (message && message.startsWith('"') && message.endsWith('"')) {
		message = consume(status).substring(1, message.length - 1);
	} else {
		add_error(status, `Expected a ${name} message`, message_start);
	}
	accept(")", status);

	const node =
		name === "panic" ? new PanicNode(node_start, message) : new TodoNode(node_start, message);
	add_to_parent(node, `${description} statement`, status);

	// TODO: Ignore requirements for this branch
	// Go up the stack looking for a returning node
	let func: ReturningNode | null = null;
	for (let i = status.stack.length - 1; i >= 0; i--) {
		if (is_returning_node(status.stack[i])) {
			func = status.stack[i] as ReturningNode;
			break;
		}
	}

	if (func) {
		func.has_return = true;
	}
}
