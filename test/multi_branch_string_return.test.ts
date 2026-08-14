import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Regression: a string literal returned from a multi-branch function is
// strdup'd on the aarch64 backend so the caller frees a valid heap copy.
// Without the fix, a function classified heap-returning (because one branch
// produces a heap string) has its literal branch lower to `adr x0, _str_N`
// (rodata), which the caller's free rejects (SIGABRT).

describe("multi-branch string return — literal + heap", () => {
	test("literal and interpolation branches", async () => {
		await build_and_check_output(
			`
func describe = (int n, out string) {
	if n == 0 {
		return "zero"
	}
	return "non-zero value is \\{n}"
}

func test = () {
	Console.write_line(describe(0))
	Console.write_line(describe(42))
}
test()
`,
			"multi_branch_string_return",
			"zero\nnon-zero value is 42\n",
		);
	});

	test("nullable struct param — string return with field access", async () => {
		await build_and_check_output(
			`
struct Span {
	var int start
	var int len
}

func describe = (Span? s, out string) {
	if s == null {
		return "none"
	}
	return "span at \\{s.start} length \\{s.len}"
}

func test = () {
	Console.write_line(describe(null))
	Console.write_line(describe(Span(5, 3)))
}
test()
`,
			"multi_branch_string_return_nullable",
			"none\nspan at 5 length 3\n",
		);
	});

	test("multiple literal branches and one heap branch", async () => {
		await build_and_check_output(
			`
func classify = (int code, out string) {
	if code == 1 {
		return "one"
	}
	if code == 2 {
		return "two"
	}
	return "code is \\{code}"
}

func test = () {
	Console.write_line(classify(1))
	Console.write_line(classify(2))
	Console.write_line(classify(99))
}
test()
`,
			"multi_branch_string_return_many",
			"one\ntwo\ncode is 99\n",
		);
	});
});
