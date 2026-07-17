import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";

export const core = get_library(import.meta.dirname.replace(/test\/spec$/, "core"));

// Parse a module-level program (declarations + a main that runs the body).
export function compile_module(body: string): ReturnType<typeof parse>["errors"] {
	let source = "import System\n";
	source += body;
	return parse(source, core).errors;
}

// Wrap free-standing statements inside a main function and parse.
export function compile_main(statements: string): ReturnType<typeof parse>["errors"] {
	const indented = statements
		.split("\n")
		.map((l) => (l.length ? "\t" + l : l))
		.join("\n");
	return compile_module(`pub func main = () {\n${indented}\n}`);
}
