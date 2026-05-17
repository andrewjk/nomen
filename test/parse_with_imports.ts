import fs from "node:fs";

import parse from "../src/parse";

const system = fs.readFileSync("./bin/tests/System.echo", "utf8");

export default function parse_with_imports(source: string) {
	let source_to_parse = `
pub func main = () {
${source}
}
${system}
`;
	return parse(source_to_parse);
}
