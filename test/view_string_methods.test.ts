import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Method calls on a `view string` receiver. The view and the owned string
// share the same 16-byte (ptr, len) ABI, so the callee's by-value `self`
// aliases the view's pair — no materialization. The C backend wraps the
// receiver in a statement-expression (nomen_view → nomen_string); aarch64
// passes the pair straight through. Sound because by-value self params are
// caller-owned: no string method frees self.

describe("string methods on view string receivers (runtime, both backends)", () => {
	test("char_code_at_or through a view param", async () => {
		await build_and_check_output(
			`
import System

func first_or_neg1 = (view string text, out int) {
	return text.char_code_at_or(0, -1)
}

pub func main = (Init init) {
	const string a = "hello"
	Console.write("\\{first_or_neg1(a)} \\{first_or_neg1(a.slice(1, 3))}")
}
`,
			"view_recv_char_code_at_or",
			"104 101",
			true,
		);
	});

	test("query methods through a view local", async () => {
		await build_and_check_output(
			`
import System

pub func main = (Init init) {
	const string a = "hello world"
	const view string v = a.slice(6, 11)
	var bool c = v.contains("wor")
	var int i = v.index_of("r")
	var bool s = v.starts_with("wor")
	var bool e = v.ends_with("rld")
	Console.write("\\{c} \\{i} \\{s} \\{e}")
}
`,
			"view_recv_query_methods",
			"true 2 true true",
			true,
		);
	});

	test("transforming methods through a view receiver", async () => {
		await build_and_check_output(
			`
import System

pub func main = (Init init) {
	const string a = "  MiXeD  "
	const view string v = a.slice(0, a.length)
	Console.write("[" + v.trim() + "] [" + v.to_lowercase() + "] [" + v.to_uppercase() + "]")
}
`,
			"view_recv_transform_methods",
			"[MiXeD] [  mixed  ] [  MIXED  ]",
			true,
		);
	});
});
