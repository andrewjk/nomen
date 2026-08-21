import path from "node:path";

import { describe, test, expect } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

const lib = get_library(path.resolve(import.meta.dirname, "../core"));

// `view string` across FUNCTION BOUNDARIES, on both backends. A view param
// is a (ptr, len) pair: an owned string argument is wrapped with its strlen
// (implicit owned→view borrow — the caller keeps ownership), a view argument
// (a slice result, a view local/param) passes through unchanged. Inside the
// callee, `.length` is the pair's len (no strlen), `.at` indexes the ptr,
// and materializing (`to_string` / `const string s = v`) copies exactly len
// bytes. View comparisons are len + memcmp (a view is not NUL-terminated).

describe("view string params and returns (runtime, both backends)", () => {
	test("owned string arg gets strlen-wrapped into the pair", async () => {
		await build_and_check_output(
			`
import System

func view_len = (view string text, out int) {
	return text.length
}

pub func main = (Init init) {
	const string a = "one\\ntwo\\n"
	Console.write("len \\{view_len(a)}")
}
`,
			"view_param_owned_len",
			"len 8",
			true,
		);
	});

	test("slice result arg passes through as a pair", async () => {
		await build_and_check_output(
			`
import System

func view_len = (view string text, out int) {
	return text.length
}

pub func main = (Init init) {
	const string a = "one\\ntwo\\n"
	if a.length == 8 {
		Console.write("len \\{view_len(a.slice(0, 3))}")
	}
}
`,
			"view_param_slice_len",
			"len 3",
			true,
		);
	});

	test("view param from a class-field read in a loop (aarch64 SIGSEGV regression)", async () => {
		await build_and_check_output(
			`
import System

func hash_it = (view string text, out int) {
	var h = 5
	var i = 0
	while i < text.length {
		h = h * 31 + (text.at(i) as int)
		i += 1
	}
	return h
}

pub class Item {
	var text = ""
}

pub func main = (Init init) {
	var List<Item> xs = List<Item>()
	var i0 = Item()
	i0.text = "one"
	xs.push(mov i0)
	var total = 0
	var i = 0
	while i < xs.length {
		total += hash_it(xs.at(i).text)
		i += 1
	}
	Console.write("h \\{hash_it("one")} \\{total}")
}
`,
			"view_param_field_loop",
			"h ",
			true,
		);
	});

	test("view param forwarding to another view param", async () => {
		await build_and_check_output(
			`
import System

func inner = (view string text, out int) {
	return text.length
}

func outer = (view string text, out int) {
	return inner(text) + 100
}

pub func main = (Init init) {
	const string a = "hello"
	Console.write("r \\{outer(a)}")
}
`,
			"view_param_forward",
			"r 105",
			true,
		);
	});

	test("view args shift later args' register slots", async () => {
		await build_and_check_output(
			`
import System

func pick = (int a, view string text, int b, out int) {
	return a * 1000 + text.length * 10 + b
}

pub func main = (Init init) {
	const string s = "abcd"
	Console.write("p \\{pick(7, s, 9)}")
}
`,
			"view_param_shift",
			"p 7049",
			true,
		);
	});

	test("view pair at the register-arg boundary (8 slots)", async () => {
		await build_and_check_output(
			`
import System

func far = (int a, int b, int c, int d, int e, int f, view string t, int g, out int) {
	return a + b + c + d + e + f + t.length + g
}

pub func main = (Init init) {
	const string s = "abcd"
	Console.write("far \\{far(1, 2, 3, 4, 5, 6, s, 7)}")
}
`,
			"view_param_register_boundary",
			"far 32",
			true,
		);
	});

	test("view pair fully past the register args (overflow area)", async () => {
		await build_and_check_output(
			`
import System

func far = (int a, int b, int c, int d, int e, int f, int g, view string t, int h, out int) {
	return a + b + c + d + e + f + g + t.length + h
}

pub func main = (Init init) {
	const string s = "abcd"
	Console.write("far \\{far(1, 2, 3, 4, 5, 6, 7, s, 8)}")
}
`,
			"view_param_overflow",
			"far 40",
			true,
		);
	});

	test("== on two view params compares len + bytes", async () => {
		await build_and_check_output(
			`
import System

func same = (view string x, view string y, out bool) {
	return x == y
}

pub func main = (Init init) {
	const string a = "one\\ntwo\\nthree"
	if a.length == 13 {
		if same(a.slice(0, 3), a.slice(0, 3)) {
			Console.write("eq")
		}
		if same(a.slice(0, 3), a.slice(4, 7)) {
			Console.write("BAD")
		} else {
			Console.write("ne")
		}
	}
}
`,
			"view_param_eq",
			"eqne",
			true,
		);
	});

	test("view vs literal comparison is bounded (no NUL reliance)", async () => {
		await build_and_check_output(
			`
import System

pub func main = (Init init) {
	const string a = "oneXXtwo"
	if a.length == 8 {
		const view string v = a.slice(0, 3)
		if v == "one" {
			Console.write("hit")
		}
		if v == "oneX" {
			Console.write("BAD")
		}
	}
}
`,
			"view_eq_literal",
			"hit",
			true,
		);
	});

	test("view string return of an owned string expr (strlen wrap)", async () => {
		await build_and_check_output(
			`
import System

pub class Item {
	var text = ""
}

func text_at = (List<Item> xs, int i, out view string) {
	if i >= 0 && i < xs.length {
		return xs.at(i).text
	}
	return ""
}

pub func main = (Init init) {
	var List<Item> xs = List<Item>()
	var i0 = Item()
	i0.text = "hello"
	xs.push(mov i0)
	if xs.length == 1 {
		Console.write("r \\{text_at(xs, 0)}")
	}
}
`,
			"view_return_owned",
			"r hello",
			true,
		);
	});

	test("view return consumed by a view local", async () => {
		await build_and_check_output(
			`
import System

pub class Item {
	var text = "hello world"
}

func text_at = (List<Item> xs, int i, out view string) {
	if i >= 0 && i < xs.length {
		return xs.at(i).text
	}
	return ""
}

pub func main = (Init init) {
	var List<Item> xs = List<Item>()
	var i0 = Item()
	xs.push(mov i0)
	const view string v = text_at(xs, 0)
	Console.write("l\\{v.length} \\{v.to_string()}")
}
`,
			"view_return_local",
			"l11 hello world",
			true,
		);
	});

	test("materializing a view into an owned string copies exactly len bytes", async () => {
		await build_and_check_output(
			`
import System

pub func main = (Init init) {
	const string a = "one\\ntwo\\nthree\\nfour\\n"
	if a.length == 19 {
		const view string v = a.slice(4, 7)
		const string s = v
		Console.write("owned \\{s} len \\{s.length}")
	}
}
`,
			"view_materialize_decl",
			"owned two len 3",
			true,
		);
	});

	test("interpolating a view materializes a bounded copy", async () => {
		await build_and_check_output(
			`
import System

pub func main = (Init init) {
	const string a = "oneXXtwoXXthree"
	if a.length == 15 {
		const view string v = a.slice(0, 3)
		Console.write("[\\{v}]")
	}
}
`,
			"view_interpolate",
			"[one]",
			true,
		);
	});

	test("method with a view param", async () => {
		await build_and_check_output(
			`
import System

pub class Scanner {
	var seed = 0

	pub func fold = (self, view string text, out int) {
		var h = self.seed
		var i = 0
		while i < text.length {
			h = h * 31 + (text.at(i) as int)
			i += 1
		}
		return h
	}
}

pub func main = (Init init) {
	const Scanner s = Scanner()
	const string a = "abc"
	Console.write("m \\{s.fold(a)}")
}
`,
			"view_param_method",
			"m ",
			true,
		);
	});
});

// The checker must annotate view params on both call shapes (free functions
// and method calls) — exercised by the runtime tests above. This check-only
// test pins the borrow rule: an owned string may be lent to a view param,
// and the call still typechecks.
describe("view param checking", () => {
	test("owned→view param calls typecheck", () => {
		const parsed = parse(
			`
import System

func take = (view string text, out int) {
	return text.length
}

pub func main = (Init init) {
	const string a = "hello"
	Console.write("\\{take(a)}")
}
`,
			lib,
		);
		expect(parsed.errors).toEqual([]);
	});
});
