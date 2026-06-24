import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// HACK: Just loading everything into a single big source file for now
// TODO: Retain line numbers!!
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIB_PATH = path.resolve(__dirname, "../../core/src");

export default function join(entry_file_path: string, lib_path?: string): string {
	const folder_path = path.dirname(entry_file_path);
	const file_path = path.basename(entry_file_path);
	const inputs = new Map();
	const resolved_lib_path = lib_path ? path.resolve(lib_path, "src") : DEFAULT_LIB_PATH;
	add_source(folder_path, file_path, inputs, resolved_lib_path);
	return Array.from(inputs.values()).join("\n\n") + "\n";
}

function add_source(
	folder_path: string,
	file_path: string,
	inputs: Map<string, string>,
	lib_path: string,
) {
	let source_path = path.resolve(folder_path, file_path);

	if (!fs.existsSync(source_path)) {
		const lib_source_path = path.resolve(lib_path, file_path);
		if (fs.existsSync(lib_source_path)) {
			source_path = lib_source_path;
		}
	}

	let source = `// file://${source_path}\n`;

	source += fs.readFileSync(source_path, "utf8");

	source = source.replaceAll(/^import(.*)$/gm, (match, name) => {
		const trimmed = name.trim();
		// `import System` and `import System/<namespace>` are library imports,
		// resolved at parse time via resolve_linked_types — not files to inline.
		if (trimmed === "System" || trimmed.startsWith("System/")) return match;
		const import_file_path = `./${trimmed}.echo`;
		if (!inputs.has(import_file_path)) {
			add_source(folder_path, import_file_path, inputs, lib_path);
		}
		return "";
	});

	inputs.set(file_path, source);
}
