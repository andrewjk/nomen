import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("readme: standard library — Console", () => {
	test("write, write_line, read_line, read_char, platform", () => {
		const input = `
Console.write("no newline")
Console.write_line("with newline")

const line = Console.read_line()
const c = Console.read_char()
const p = Console.platform()
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: standard library — Ansi", () => {
	test("bg_red, bold, green styling helpers", () => {
		const input = `
Console.write("\\{Ansi.bg_red("ERROR")}: it didn't work")
Console.write_line(Ansi.bold(Ansi.green("success")))
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: compile-time json", () => {
	test("typed structs round-trip through JSON", () => {
		const input = `
mv struct Account {
    @rename("user")
    mv id = ""
    var active = true
    @skip
    mv cache = ""
}

func round_trip = (string text, out string) {
    var a = Account()
    json_decode_into(text, ref a)
    return json_encode(ref a)
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("readme: imports and visibility", () => {
	test("imports name namespaces; qualified references resolve through them", () => {
		const input = `
import System::Controls

const size = Controls::Size()
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("readme: ffi", () => {
	test("library externs are callable through their wrappers", () => {
		const input = `
pub func main = () {
    Console.write_line("\\{parse_int("41")}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});
