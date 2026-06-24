import type BuildStatus from "../build_c/BuildStatus.ts";
import RawNode from "../nodes/RawNode.ts";
import { parse_raw_directives } from "../raw_directives.ts";

export default function build_raw_node(node: RawNode, status: BuildStatus) {
	const { should_emit, code } = parse_raw_directives(node.value, "aarch64", status.platform);
	if (should_emit && code) {
		status.code += `${code}\n`;
	}
}
