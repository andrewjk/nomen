import path from "node:path";

import { get_library } from "../src/lib";
import parse from "../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

export default function parse_with_imports(source: string, options?: { allow_user_raw?: boolean }) {
	let source_to_parse = `
import System
pub func main = () {
${source}
}
`;
	return parse(source_to_parse, system, undefined, { allow_internal: true, ...options });
}

export function parse_raw(source: string) {
	// The raw-splicing machinery tests hand-write user-shaped programs with
	// `#arch:` blocks; production builds never set allow_user_raw, so real
	// user code cannot reach raw pointer manipulation.
	return parse(source, system, undefined, { allow_user_raw: true, allow_internal: true });
}
