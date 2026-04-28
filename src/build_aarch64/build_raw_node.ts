import RawNode from "../nodes/RawNode";
import type BuildStatus from "../build/BuildStatus";

export default function build_raw_node(node: RawNode, status: BuildStatus) {
  status.code += `${node.value}\n`;
}
