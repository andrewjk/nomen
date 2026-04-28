import PanicNode from "../nodes/PanicNode";
import type BuildStatus from "../build/BuildStatus";

export default function build_panic_node(node: PanicNode, status: BuildStatus) {
  // TODO: Unwind etc
  const label = `_str_panic_${node.message.replace(/[^a-zA-Z0-9]/g, "_")}`;
  status.strings!.set(label, `"${node.message}\\n"`);
  status.code += `adr x0, ${label}\n`;
  status.code += `bl printf\n`;
  status.code += `mov x0, #1\n`;
  status.code += `bl exit\n`;
}
