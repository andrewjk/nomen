import type BuildStatus from "../build_c/BuildStatus.ts";
import TodoNode from "../nodes/TodoNode.ts";
import { emit_asm } from "./utils/code_buffer.ts";

export default function build_todo_node(node: TodoNode, status: BuildStatus) {
	const msg = node.message + "\\n";
	const label = `_str_todo_${node.message.replace(/[^a-zA-Z0-9]/g, "_")}`;
	status.strings!.set(label, `"${msg}"`);
	const len = msg.length - 1;
	emit_asm(status, `mov x0, #2\n`);
	emit_asm(status, `adr x1, ${label}\n`);
	emit_asm(status, `mov x2, #${len}\n`);
	emit_asm(status, `mov x16, #4\n`);
	emit_asm(status, `svc #0x80\n`);
	emit_asm(status, `mov x0, #1\n`);
	emit_asm(status, `mov x16, #1\n`);
	emit_asm(status, `svc #0x80\n`);
}
