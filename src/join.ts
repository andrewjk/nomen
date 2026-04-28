//import { promises as fs } from "node:fs";
import fs from "node:fs";
import path from "node:path";

// HACK: Just loading everything into a single big source file for now
// TODO: Retain line numbers!!

export default function join(entry_file_path: string): string {
	const folder_path = path.dirname(entry_file_path);
	const file_path = path.basename(entry_file_path);
	const inputs = new Map();
	add_source(folder_path, file_path, inputs);
	return Array.from(inputs.values()).join("\n\n") + "\n";
}

function add_source(folder_path: string, file_path: string, inputs: Map<string, string>) {
	const source_path = path.resolve(folder_path, file_path);

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
