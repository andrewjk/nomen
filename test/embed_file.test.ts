import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// `#embed_file("path")` — SPEC.md, "Compile-time Embedding". The literal is
// materialized at parse time (the file is read by the compiler), so both
// backends see an ordinary string literal. The embedded bytes include the
// escape-sensitive forms (quote, tab, newline, a control byte) that the
// literal encoding must round-trip.

const CORPUS = 'hello\nembed "world"\ttab\x01end\n';

describe("embedFile", () => {
	test("const initializer carries the file's bytes on both backends", async () => {
		const input = `
const string corpus = #embed_file("test/fixtures/embed_corpus.txt")
Console.write(corpus)
Console.write("\\{corpus.length}\\n")
`;
		await build_and_check_output(input, "embed_file_const", CORPUS + `${CORPUS.length}\n`);
	});

	test("interpolation and slicing see an ordinary string", async () => {
		const input = `
const string banner = #embed_file("assets/banner.txt")
Console.write("\\{banner.length}|\\{banner.slice(0, 5).to_string()}|\\n")
`;
		// banner = "NOMEN\ncompile-time embedded text\n" — length 33, slice(0,5) = "NOMEN"
		await build_and_check_output(input, "embed_file_methods", "33|NOMEN|\n");
	});
});
