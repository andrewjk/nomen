import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Hidden string-length companions (PERF gap 2.4): a by-value `string` param
// whose body reads `.length` is lowered as (char*, long _<name>_len) — the
// length is threaded through the call boundary instead of the callee paying
// a `strlen` per CALL. A helper called once per line over a large document
// therefore costs one hoisted strlen, not O(lines x bytes). The companion
// mirrors the nullable `_has` flag convention: it trails its parameter in
// every signature, and call sites append it right after the string argument.

describe("hidden string-length companion params", () => {
	test("helper reading .length in a loop", async () => {
		const input = `
func count_vowels = (string text, out int) {
	var int count = 0
	var int i = 0
	while i < text.length {
		if text.at(i) == 'a' || text.at(i) == 'e' || text.at(i) == 'i' {
			count = count + 1
		}
		i = i + 1
	}
	return count
}
var string doc = "arena item"
Console.write("\\{count_vowels(doc)} \\{count_vowels("bee")}")
`;
		await build_and_check_output(input, "hlen_loop_helper", "5 2");
	});

	test("two string params keep their companions interleaved", async () => {
		const input = `
func longer_len = (string a, string b, out int) {
	if a.length >= b.length {
		return a.length
	}
	return b.length
}
var string s1 = "kite"
var string s2 = "umbrella"
Console.write("\\{longer_len(s1, s2)} \\{longer_len(s2, s1)} \\{longer_len("xy", "zw")}")
`;
		await build_and_check_output(input, "hlen_two_params", "8 8 2");
	});

	test("struct method with a string param", async () => {
		const input = `
pub struct Counter {
	var int hits = 0

	pub func scan = (ref self, string needle) {
		var int i = 0
		while i < needle.length {
			if needle.at(i) == 'x' {
				self.hits = self.hits + 1
			}
			i = i + 1
		}
	}
}
var Counter c = Counter()
c.scan("xx yy")
c.scan("zz")
Console.write("\\{c.hits}")
`;
		await build_and_check_output(input, "hlen_method", "2");
	});

	test("calls inside a while loop reuse one hoisted strlen", async () => {
		const input = `
func count_hs = (string s, out int) {
	var int i = 0
	var int h = 0
	while i < s.length {
		if s.at(i) == 'h' {
			h = h + 1
		}
		i = i + 1
	}
	return h
}
var string line = "hi"
var int hits = 0
var int n = 0
while n < 4 {
	hits = hits + count_hs(line)
	n = n + 1
}
Console.write("\\{hits}")
`;
		await build_and_check_output(input, "hlen_caller_loop", "4");
	});

	test("rvalue argument is evaluated once", async () => {
		const input = `
func len_or_cap = (string s, out int) {
	var int n = s.length
	if n > 10 {
		return 10
	}
	return n
}
func make = (int k, out string) {
	var string r = ""
	var int i = 0
	while i < k {
		r = r + "ab"
		i = i + 1
	}
	return r
}
Console.write("\\{len_or_cap(make(3))} \\{len_or_cap(make(9))}")
`;
		await build_and_check_output(input, "hlen_rvalue_arg", "6 10");
	});

	test("ref string params are not companion-stamped", async () => {
		const input = `
func measure_ref = (ref string s, out int) {
	return s.length * 2
}
var string owned = "wasp"
Console.write("\\{measure_ref(ref owned)}")
`;
		await build_and_check_output(input, "hlen_ref_excluded", "8");
	});

	test("static method call in a loop keeps its string argument in x0", async () => {
		// Regression: the companion load from a hoisted strlen temp used x0
		// as scratch AFTER the argument registers were claimed — the string
		// pointer was overwritten by its own length (SIGSEGV in the callee's
		// string_at). A static-method call site (build_access_node) inside a
		// while loop over a bare variable hits exactly that path.
		const input = `
pub struct Scanner {
	pub func count = (string s, out int) {
		var int i = 0
		var int n = 0
		while i < s.length {
			if s.at(i) == 'q' {
				n = n + 1
			}
			i = i + 1
		}
		return n
	}
}
var string text = "qqa q"
var int total = 0
var int k = 0
while k < 3 {
	total = total + Scanner.count(text)
	k = k + 1
}
Console.write("\\{total}")
`;
		await build_and_check_output(input, "hlen_method_loop_hoist", "9");
	});
});

describe("hidden-len lowering shape", () => {
	test("callee signature carries the companion; body has no strlen", () => {
		const input = `
func plen = (string s, out int) {
	return s.length + 1
}
Console.write("\\{plen("cat")}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		for (const arch of ["aarch64", "c"] as const) {
			const result = build(parsed.root, { arch, audit: false });
			if (arch === "c") {
				expect(result.code).toContain("long plen(char* s, long _s_len)");
				// The callee reads the companion param, not strlen.
				expect(result.code).not.toContain("strlen(s)");
				// The literal call site folds to sizeof - 1.
				expect(result.code).toContain('plen("cat", sizeof("cat") - 1)');
			}
		}
	});
});
