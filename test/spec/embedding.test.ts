import { describe, expect, test } from "vite-plus/test";

import { compile_main } from "./_helpers.ts";

// SPEC.md, "Compile-time Embedding": every fenced example in the section
// must compile with no errors.
describe("spec: compile-time embedding", () => {
	test("#embed_file is a string literal of the file's contents", () => {
		const input = `
const string banner = #embed_file("assets/banner.txt")
Console.write(banner)
`;
		expect(compile_main(input)).toEqual([]);
	});
});
