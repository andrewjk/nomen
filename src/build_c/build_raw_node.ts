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
			// A MIXED function (Nomen statements + a raw block) keeps its fat
			// nomen_string params in the generated code. Most raw bodies were
			// authored against the thin char* ABI: shim each by-value string
			// param that the body references BARE to its ptr half for the
			// duration of the block. A param already accessed as `name.ptr` /
			// `name.len` is fat-aware authoring — shimming it would rewrite
			// those accesses to `<thin>.ptr` (compile error), so it is left
			// alone.
			const shims = [...(status.fat_string_params ?? [])].filter((name) => {
				const fat_aware = new RegExp(`\\b${name}\\s*\\.\\s*(ptr|len)\\b`).test(code);
				return !fat_aware && new RegExp(`\\b${name}\\b`).test(code);
			});
			for (const name of shims) {
				status.code += `const char* _nomen_thin_${name} = ${name}.ptr;\n`;
				status.code += `#define ${name} _nomen_thin_${name}\n`;
			}
			status.code += `${code}\n`;
			for (const name of shims) {
				status.code += `#undef ${name}\n`;
			}
		}
	}
}
