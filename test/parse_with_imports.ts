import path from "node:path";

import { get_library } from "../src/lib";
import parse from "../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../lib"));

export default function parse_with_imports(source: string) {
	let source_to_parse = `
import System
pub func main = () {
${source}
}
`;
	return parse(source_to_parse, system);
}
