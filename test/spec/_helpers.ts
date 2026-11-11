import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";

export const core = get_library(import.meta.dirname.replace(/test\/spec$/, "core"));

// Style lints that must never fire on a clean doc example. Only the
// redundant-annotation lint is asserted: an annotation the checker can prove
// redundant is never justified in docs (the var-never-changed lint is a
// judgment call — SPEC deliberately teaches `var` spellings, destructuring
// bindings and func-typed declarations that are never reassigned).
const STYLE_WARNING_MARKS = ["Type annotation on"];

function assert_lint_clean(
	parsed: ReturnType<typeof parse>,
	source: string,
): ReturnType<typeof parse>["errors"] {
	if (parsed.errors.length === 0) {
		const style_warnings = (parsed.warnings ?? []).filter((w) =>
			STYLE_WARNING_MARKS.some((m) => w.message.includes(m)),
		);
		if (style_warnings.length > 0) {
			const lines = source.split("\n");
			const details = style_warnings
				.map((w) => `  ${w.message}\n    -> ${lines[w.line - 1]?.trim() ?? ""}`)
				.join("\n");
			throw new Error("doc example is not lint-clean:\n" + details);
		}
	}
	return parsed.errors;
}

// Parse a module-level program (declarations + a main that runs the body).
export function compile_module(body: string): ReturnType<typeof parse>["errors"] {
	let source = "import System\n";
	source += body;
	// Spec snippets are trusted like the rest of the suite: the examples drive
	// System internals (e.g. `Buffer`) that user builds keep locked down.
	return assert_lint_clean(parse(source, core, undefined, { allow_internal: true }), source);
}

// Wrap free-standing statements inside a main function and parse.
export function compile_main(statements: string): ReturnType<typeof parse>["errors"] {
	const indented = statements
		.split("\n")
		.map((l) => (l.length ? "\t" + l : l))
		.join("\n");
	return compile_module(`pub func main = () {\n${indented}\n}`);
}
