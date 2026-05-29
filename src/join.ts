import fs from "node:fs";
import path from "node:path";

// HACK: Just loading everything into a single big source file for now
// TODO: Retain line numbers!!
const LIB_PATH = path.resolve(__dirname, "../lib/src");

export default function join(entry_file_path: string): string {
	const folder_path = path.dirname(entry_file_path);
	const file_path = path.basename(entry_file_path);
	const inputs = new Map();
	add_source(folder_path, file_path, inputs);
	return Array.from(inputs.values()).join("\n\n") + "\n";
}

function add_source(folder_path: string, file_path: string, inputs: Map<string, string>) {
	let source_path = path.resolve(folder_path, file_path);

	if (!fs.existsSync(source_path)) {
		const lib_source_path = path.resolve(LIB_PATH, file_path);
		if (fs.existsSync(lib_source_path)) {
			source_path = lib_source_path;
		}
	}

	let source = `// file://${source_path}\n`;

	source += fs.readFileSync(source_path, "utf8");

	source = source.replaceAll(/^import(.*)$/gm, (match, name) => {
		const import_file_path = `./${name.trim()}.echo`;
		if (!inputs.has(import_file_path)) {
			add_source(folder_path, import_file_path, inputs);
		}
		return "";
	});

	inputs.set(file_path, source);
}
