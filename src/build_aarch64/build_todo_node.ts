import type BuildStatus from "../build_c/BuildStatus.ts";
import TodoNode from "../nodes/TodoNode.ts";

export default function build_todo_node(node: TodoNode, status: BuildStatus) {
	const msg = node.message + "\\n";
	const label = `_str_todo_${node.message.replace(/[^a-zA-Z0-9]/g, "_")}`;
	status.strings!.set(label, `"${msg}"`);
	const len = msg.length - 1;
	status.code += `mov x0, #2\n`;
	status.code += `adr x1, ${label}\n`;
	status.code += `mov x2, #${len}\n`;
	status.code += `mov x16, #4\n`;
	status.code += `svc #0x80\n`;
	status.code += `mov x0, #1\n`;
	status.code += `mov x16, #1\n`;
	status.code += `svc #0x80\n`;
}
