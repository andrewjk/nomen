import fs from "node:fs";
import path from "node:path";

/**
 * The project root for `input_path`: the nearest ancestor folder (or the input
 * folder itself) containing a `package.jsonc`. Falls back to the input's own
 * folder for standalone files, so builds stay next to their source.
 */
export function project_root_for(input_path: string): string {
	let dir = fs.lstatSync(input_path).isDirectory() ? input_path : path.dirname(input_path);
	for (let i = 0; i < 20; i++) {
		if (fs.existsSync(path.join(dir, "package.jsonc"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.dirname(input_path);
}

/**
 * The folder that receives compiler output for `input_path`: the project's
 * `build/`, or `build/test` for `*.test.nm` files.
 */
export function build_dir_for(input_path: string, is_test: boolean): string {
	return is_test
		? path.join(project_root_for(input_path), "build", "test")
		: path.join(project_root_for(input_path), "build");
}
