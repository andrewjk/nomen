import type BuildStatus from "../build_c/BuildStatus.ts";
import RawNode from "../nodes/RawNode.ts";

function should_emit_for_arch(content: string, arch: string): [boolean, string] {
	const lines = content.split("\n");
	if (lines.length > 0 && lines[0].trim().startsWith("#arch:")) {
		const arches = lines[0]
			.trim()
			.substring(6)
			.split(",")
			.map((a) => a.trim());
		const should_emit = arches.includes(arch);
		const code = lines.slice(1).join("\n").trim();
		return [should_emit, code];
	}
	// No arch directive, emit for all
	return [true, content];
}

export default function build_raw_node(node: RawNode, status: BuildStatus) {
	const [should_emit, code] = should_emit_for_arch(node.value, "aarch64");
	if (should_emit && code) {
		status.code += `${code}\n`;
	}
}
