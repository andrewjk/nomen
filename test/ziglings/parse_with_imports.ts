import path from "node:path";

import { get_library } from "../../src/lib";
import parse from "../../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../../core"));

export default function parse_with_imports(source: string) {
	if (source.includes("import System")) {
		return parse(source, system);
	}
	return parse(source);
}
