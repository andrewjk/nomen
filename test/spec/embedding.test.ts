import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import { compile_main } from "./_helpers.ts";

// SPEC.md, "Compile-time Embedding": every fenced example in the section
// must compile with no errors.
describe("spec: compile-time embedding", () => {
	test("#embed_file is a string literal of the file's contents", () => {
		const input = `
const banner = #embed_file("assets/banner.txt")
Console.write(banner)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("binary files round-trip byte-exactly", async () => {
		// embed_bytes.bin holds every byte value 0..255 in order — NULs, high
		// bytes, quotes, backslashes — so the escape encoding must decode
		// byte-identically (the GUI's embedded app icon relies on this).
		const input = `
const data = #embed_file("test/fixtures/embed_bytes.bin")
Console.write_line("\\{data.length}")
Console.write_line("\\{data.at(0) as int} \\{data.at(1) as int} \\{data.at(127) as int} \\{data.at(128) as int} \\{data.at(255) as int}")
`;
		await build_and_check_output(input, "embed_binary_roundtrip", "256\n0 1 127 128 255");
	});
});
