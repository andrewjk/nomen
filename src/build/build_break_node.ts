import BreakNode from "../nodes/BreakNode";
import type BuildStatus from "./BuildStatus";

export default function build_break_node(node: BreakNode, status: BuildStatus) {
  status.code += `break`;
}
