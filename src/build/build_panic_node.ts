import PanicNode from "../nodes/PanicNode";
import type BuildStatus from "./BuildStatus";

export default function build_panic_node(node: PanicNode, status: BuildStatus) {
  // TODO: Unwind etc
  status.code += `printf("${node.message}\\n");\n`;
  status.code += `exit(EXIT_FAILURE);\n`;
}
