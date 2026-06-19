import type BuildStatus from "../build_c/BuildStatus.ts";
import PanicNode from "../nodes/PanicNode.ts";

export default function build_panic_node(node: PanicNode, status: BuildStatus) {
	const msg = node.message + "\\n";
	const label = `_str_panic_${node.message.replace(/[^a-zA-Z0-9]/g, "_")}`;
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
