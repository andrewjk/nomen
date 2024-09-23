import TodoNode from "../nodes/TodoNode";
import type BuildStatus from "./BuildStatus";

export default function build_todo_node(node: TodoNode, status: BuildStatus) {
  // TODO: Unwind etc
  status.code += `printf("${node.message}\\n");\n`;
  status.code += `exit(EXIT_FAILURE);\n`;
}
