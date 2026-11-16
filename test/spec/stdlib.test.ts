import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("spec: console", () => {
	test("Console write and write_line", () => {
		const input = `
Console.write("no newline")
Console.write_line("with newline")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("Console read functions and platform", () => {
		const input = `
const line = Console.read_line()
const c = Console.read_char()
const p = Console.platform()
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: ansi", () => {
	test("Ansi styling helpers", () => {
		const input = `
Console.write("\\{Ansi.bg_red("ERROR")}: it didn't work")
Console.write_line(Ansi.bold(Ansi.green("success")))
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: json serde", () => {
	test("json_decode_into / json_encode round-trip a typed struct", () => {
		const input = `
@rename("user")
mv struct Account {
	var id = ""
	var active = true
	@skip
	var cache = ""
}

func round_trip = (string text, out string) {
	var a = Account()
	json_decode_into(text, ref a)
	return json_encode(a)
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: generic construction", () => {
	test("T() constructs the bound type inside a generic body", () => {
		const input = `
mv struct Item {
    var n = 0
    var label = ""
}

func default_of<T> = (T seed, out T) {
    var value = T()
    return value
}

func first_push<T> = (ref StableList<T> list, T seed) {
    var item = T()
    list.push(mv item)
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
