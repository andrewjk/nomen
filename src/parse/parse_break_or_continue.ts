import BreakNode from "../nodes/BreakNode";
import ContinueNode from "../nodes/ContinueNode";
import type ParseStatus from "./ParseStatus";
import accept from "./utils/accept";
import add_to_parent from "./utils/add_to_parent";
import get_index from "./utils/get_index";

export default function parse_break_or_continue(name: "break" | "continue", status: ParseStatus) {
  const description = name.substring(0, 1).toUpperCase() + name.substring(1);

  const node_start = get_index(status);
  accept(name, status);

  const node = name === "break" ? new BreakNode(node_start) : new ContinueNode(node_start);
  add_to_parent(node, `${description} statement`, status);
}
