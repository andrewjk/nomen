import ContinueNode from "../nodes/ContinueNode";
import type BuildStatus from "./BuildStatus";

export default function build_continue_node(node: ContinueNode, status: BuildStatus) {
  status.code += `continue`;
}
