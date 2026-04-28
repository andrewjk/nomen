import TodoNode from "../nodes/TodoNode.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_todo_node(node: TodoNode, status: BuildStatus) {
  // TODO: Unwind etc
  status.code += `printf("${node.message}\\n");\n`;
  status.code += `exit(EXIT_FAILURE);\n`;
}
