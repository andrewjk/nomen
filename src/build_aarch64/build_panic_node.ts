import type BuildStatus from "../build_c/BuildStatus.ts";
import PanicNode from "../nodes/PanicNode.ts";
import { emit_asm } from "./utils/code_buffer.ts";

export default function build_panic_node(node: PanicNode, status: BuildStatus) {
	const msg = node.message + "\\n";
	const label = `_str_panic_${node.message.replace(/[^a-zA-Z0-9]/g, "_")}`;
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
