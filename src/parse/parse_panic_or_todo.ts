import PanicNode from "../nodes/PanicNode";
import ReturningNode from "../nodes/ReturningNode";
import TodoNode from "../nodes/TodoNode";
import isReturningNode from "../nodes/isReturningNode";
import type ParseStatus from "./ParseStatus";
import accept from "./utils/accept";
import add_to_parent from "./utils/add_to_parent";
import consume from "./utils/consume";
import get_index from "./utils/get_index";
import peek_current from "./utils/peek_current";

export default function parse_panic_or_todo(name: "panic" | "todo", status: ParseStatus) {
  const description = name.substring(0, 1).toUpperCase() + name.substring(1);

  const node_start = get_index(status);
  accept(name, status);

  const message_start = get_index(status);
  let message = peek_current(status);
  if (message && message.startsWith('"') && message.endsWith('"')) {
    message = consume(status).substring(1, message.length - 1);
  } else {
    status.errors.push({
      message: `Expected a ${name} message`,
      start: message_start,
    });
  }

  const node =
    name === "panic" ? new PanicNode(node_start, message) : new TodoNode(node_start, message);
  add_to_parent(node, `${description} statement`, status);

  // TODO: Ignore requirements for this branch
  // Go up the stack looking for a returning node
  let func: ReturningNode | null = null;
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (isReturningNode(status.stack[i])) {
      func = status.stack[i] as ReturningNode;
      break;
    }
  }

  if (func) {
    func.has_return = true;
  }
}
