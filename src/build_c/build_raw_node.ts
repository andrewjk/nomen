import RawNode from "../nodes/RawNode.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_raw_node(node: RawNode, status: BuildStatus) {
	// Target selection happened at the fold (stage 5, docs/COMPTIME.md)
	// — only blocks that exist for this target survive to the backends. On
	// the C backend every surviving block is C source; the `#raw("c")`
	// dialect is the aarch64 companion's concern.
	const code = node.value;
	const scope = node.scope ?? "block";
	if (code) {
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
			// Raw bodies see fat nomen_string params directly (there is no
			// thin ABI — see docs/MEMORY.md): a C `char*` is the explicit
			// `.ptr` half, and the body is emitted verbatim.
			status.code += `${code}\n`;
		}
	}
}
