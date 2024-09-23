import FunctionNode from "../nodes/FunctionNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";
import build_parameter_node from "./build_parameter_node";

export default function build_function_node(node: FunctionNode, status: BuildStatus) {
  if (node.name.toLocaleLowerCase() === "main") {
    status.code += `int main(`;
  } else {
    status.code += `void ${node.name}(`;
  }
  for (let i = 0; i < node.params.length; i++) {
    if (i > 0) {
      status.code += ", ";
    }
    build_parameter_node(node.params[i], status);
  }
  status.code += `)\n{\n`;
  for (let child of node.statements) {
    build_node(child, status);
  }
  status.code += `}\n`;
}
