import RawNode from "../nodes/RawNode.ts";
import { parse_raw_directives } from "../raw_directives.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_raw_node(node: RawNode, status: BuildStatus) {
	const { should_emit, code, scope } = parse_raw_directives(node.value, "c", status.platform);
	if (should_emit && code) {
		if (scope === "file") {
			status.headers += `${code}\n`;
		} else {
			status.code += `${code}\n`;
		}
	}
}
