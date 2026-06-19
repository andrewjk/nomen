import RawNode from "../nodes/RawNode.ts";
import type BuildStatus from "./BuildStatus.ts";

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
	return [true, content];
}

function is_file_scope(content: string): boolean {
	const lines = content.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#scope:")) {
			return trimmed.substring(7).trim() === "file";
		}
		if (trimmed.length > 0 && !trimmed.startsWith("#")) {
			break;
		}
	}
	return false;
}

function strip_directives(content: string): string {
	return content
		.split("\n")
		.filter((line) => !line.trim().startsWith("#scope:"))
		.join("\n")
		.trim();
}

export default function build_raw_node(node: RawNode, status: BuildStatus) {
	const [should_emit, code] = should_emit_for_arch(node.value, "c");
	if (should_emit && code) {
		const clean = strip_directives(code);
		if (!clean) return;
		if (is_file_scope(node.value)) {
			status.headers += `${clean}\n`;
		} else {
			status.code += `${clean}\n`;
		}
	}
}
