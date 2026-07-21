import RawNode from "../nodes/RawNode.ts";
import { parse_raw_directives } from "../raw_directives.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_raw_node(node: RawNode, status: BuildStatus) {
	const { should_emit, code, scope } = parse_raw_directives(node.value, "c", status.platform);
	if (should_emit && code) {
		if (scope === "file") {
			if (!status.emitted_file_scope_blocks) {
				status.emitted_file_scope_blocks = new Set();
			}
			// Dedup: generic struct monomorphization emits the same file-scope
			// block (pool infrastructure, type defs, etc.) multiple times.
			if (status.emitted_file_scope_blocks.has(code)) return;
			status.emitted_file_scope_blocks.add(code);
			status.headers += `${code}\n`;
		} else {
			status.code += `${code}\n`;
		}
	}
}
