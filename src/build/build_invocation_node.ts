import InvocationNode from "../nodes/InvocationNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";

export default function build_invocation_node(node: InvocationNode, status: BuildStatus) {
  status.code += `${node.name}(`;
  for (let i = 0; i < node.params.length; i++) {
    if (i > 0) {
      status.code += ", ";
    }
    build_node(node.params[i], status);
  }
  status.code += ");\n";
}
