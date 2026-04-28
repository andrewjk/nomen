import TodoNode from "../nodes/TodoNode";
import type BuildStatus from "../build/BuildStatus";

export default function build_todo_node(node: TodoNode, status: BuildStatus) {
  // TODO: Unwind etc
  const label = `_str_todo_${node.message.replace(/[^a-zA-Z0-9]/g, "_")}`;
  status.strings!.set(label, `"${node.message}\\n"`);
  status.code += `adr x0, ${label}\n`;
  status.code += `bl printf\n`;
  status.code += `mov x0, #1\n`;
  status.code += `bl exit\n`;
}
