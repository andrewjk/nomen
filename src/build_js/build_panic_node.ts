import type PanicNode from "../nodes/PanicNode.ts";
import { emit } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** `panic("…")` — the runtime prints the message to stderr and exits 2, the
 *  same contract as the native backends. */
export default function build_panic_node(node: PanicNode, status: BuildStatus): void {
	emit(status, `__panic(${JSON.stringify(node.message)});`);
}
