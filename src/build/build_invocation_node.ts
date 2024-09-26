import InvocationNode from "../nodes/InvocationNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";
import type_from_value_node from "./utils/type_from_value_node";

export default function build_invocation_node(node: InvocationNode, status: BuildStatus) {
  status.code += `${node.name}(`;
  for (let i = 0; i < node.params.length; i++) {
    if (i > 0) {
      status.code += ", ";
    }

    // HACK: Always passing the pointer in -- maybe we shouldn't do this for ints etc
    const param_type = type_from_value_node(node.params[i]);
    if (
      status.structs.find((s) => s.name === param_type.name) ||
      status.traits.find((t) => t.name === param_type.name)
    ) {
      status.code += `(void *)&`;
    }

    build_node(node.params[i], status);
  }
  status.code += ");\n";
}
