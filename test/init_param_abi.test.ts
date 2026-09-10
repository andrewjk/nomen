import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// The aarch64 custom-#init prologue treated a fat `string` param as ONE
// register slot, so every scalar param AFTER a string param read the wrong
// register (the string's len half) and two-string inits mis-spilled both
// halves. These pin the (ptr, len) pair ABI for custom inits on both
// backends.

describe("custom init param ABI", () => {
	test("class #init: scalar after a string param", async () => {
		const input = `
import System

class N1 {
	var string kind
	var int idx

	pub func #init = (ref self, string k, int i) {
		self.kind = k
		self.idx = i
	}
}

pub func main = (Init init) {
	var n = N1("c", 7)
	Console.write("\\{n.idx} \\{n.kind}\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "init_abi_class_string_int", "7 c\n", true);
	});

	test("struct #init: two string params", async () => {
		const input = `
import System

pub struct S2 {
	pub var string url
	pub var string title

	pub func #init = (ref self, string u, string t) {
		self.url = u
		self.title = t
	}
}

pub func main = (Init init) {
	var r = S2("http://x", "t")
	Console.write("\\{r.url} \\{r.title}\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "init_abi_struct_two_strings", "http://x t\n", true);
	});

	test("struct #init: string, int, string interleaved", async () => {
		const input = `
import System

pub struct P2 {
	pub var string a
	pub var int b
	pub var string c

	pub func #init = (ref self, string x, int k, string y) {
		self.a = x
		self.b = k
		self.c = y
	}
}

pub func main = (Init init) {
	var p = P2("aa", 9, "bb")
	Console.write("\\{p.a},\\{p.b},\\{p.c}\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "init_abi_struct_interleaved", "aa,9,bb\n", true);
	});
});
