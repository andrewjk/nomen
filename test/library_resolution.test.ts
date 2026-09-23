import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse, { resolve_linked_types } from "../src/parse.ts";

const core = path.resolve(import.meta.dirname, "../core");

describe("library resolution", () => {
	test("importing System::Text does not drag Controls (ObjC) into the build", () => {
		const input = `
import System::Text::Regex

pub func main = () {
	if Regex.test("a", "abc") {
		Console.write_line("yes")
	}
}
`;
		const library = get_library(core);
		const resolved = resolve_linked_types(input, library);
		expect(resolved).not.toContain("objc_msgSend");
		expect(resolved).not.toContain("NSWindow");
	});

	test("importing System::Text::Regex still resolves the Regex module", () => {
		const input = `
import System::Text::Regex

pub func main = () {
	if Regex.test("a", "abc") {
		Console.write_line("yes")
	}
}
`;
		const parsed = parse(input, get_library(core));
		expect(parsed.errors).toEqual([]);
	});

	test("a namespace import still pulls the whole namespace", () => {
		const input = `
import System::Text

pub func main = () {
	var StringBuilder sb = StringBuilder()
	sb.seed("hi")
	Console.write_line(sb.to_string())
}
`;
		const parsed = parse(input, get_library(core));
		expect(parsed.errors).toEqual([]);
	});

	test("types genuinely referenced by name still resolve", () => {
		const input = `
import System

pub func main = () {
	var List<int> xs = List<int>()
	xs.push(1)
	Console.write_line(xs.at_or_panic(0).to_string())
}
`;
		const parsed = parse(input, get_library(core));
		expect(parsed.errors).toEqual([]);
	});
});
