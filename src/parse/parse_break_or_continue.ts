import BreakNode from "../nodes/BreakNode.ts";
import ContinueNode from "../nodes/ContinueNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import get_index from "./utils/get_index.ts";

export default function parse_break_or_continue(name: "break" | "continue", status: ParseStatus) {
  const description = name.substring(0, 1).toUpperCase() + name.substring(1);

  const node_start = get_index(status);
  accept(name, status);

  const node = name === "break" ? new BreakNode(node_start) : new ContinueNode(node_start);
  add_to_parent(node, `${description} statement`, status);
}
