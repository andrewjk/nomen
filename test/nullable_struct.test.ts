import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Nullable struct VALUE types (`T?` where T is a non-class struct) cross
// function boundaries via:
//  - C: a sibling `unsigned char <name>_has` flag parameter, plus a hidden
//    `unsigned char *_ret_has` out-parameter for returns.
//  - aarch64: combined `[struct | flag]` storage pointed at by the param
//    register / sret buffer (x8), so the callee reads the flag at
//    `[ptr + struct_size]`.
// These tests cover the previously-unsupported cases: returning a nullable
// struct from a function, passing one as a parameter, and `??` coalescing
// on a nullable-struct call result — on BOTH backends. The pre-existing
// local/field cases (which worked before) are covered in test/nullable.test.ts.

describe("nullable struct value — return type", () => {
	test("function returning nullable struct — non-null path", async () => {
		await build_and_check_output(
			`
struct Point {
	var int x
	var int y
}

func make = (int x, out Point?) {
	return Point(x, x * 2)
}

func test = () {
	var Point? p = make(7)
	if p != null {
		Console.write_line("\\{p.x}|\\{p.y}")
	}
}
test()
`,
			"ns_return_nonnull",
			"7|14\n",
		);
	});

	test("function returning nullable struct — null path", async () => {
		await build_and_check_output(
			`
struct Point {
	var int x
	var int y
}

func maybe = (int x, out Point?) {
	if x > 0 {
		return Point(x, x)
	}
	return null
}

func test = () {
	var Point? p = maybe(0)
	if p != null {
		Console.write_line("\\{p.x}")
	} else {
		Console.write_line("null")
	}
}
test()
`,
			"ns_return_null",
			"null\n",
		);
	});

	test("function returning nullable struct — both paths in sequence", async () => {
		await build_and_check_output(
			`
struct Anchor {
	var int index
	var bool found
}

func find_anchor = (int target, int max, out Anchor?) {
	if target < max {
		return Anchor(target, true)
	}
	return null
}

func test = () {
	var Anchor? a = find_anchor(3, 10)
	var Anchor? b = find_anchor(20, 10)
	if a != null {
		Console.write_line("a at \\{a.index}")
	} else {
		Console.write_line("a missing")
	}
	if b != null {
		Console.write_line("b at \\{b.index}")
	} else {
		Console.write_line("b missing")
	}
}
test()
`,
			"ns_return_anchor",
			"a at 3\nb missing\n",
		);
	});
});

describe("nullable struct value — parameter", () => {
	test("nullable struct param — null, fresh value, and variable args", async () => {
		await build_and_check_output(
			`
struct Point {
	var int x
	var int y
}

func use = (Point? p) {
	if p != null {
		Console.write_line("\\{p.x}")
	} else {
		Console.write_line("null")
	}
}

func test = () {
	use(null)
	use(Point(3, 4))
	var Point? q = Point(9, 16)
	use(q)
}
test()
`,
			"ns_param",
			"null\n3\n9\n",
		);
	});

	test("nullable struct param — forwarded to another nullable param", async () => {
		await build_and_check_output(
			`
struct Point {
	var int x
	var int y
}

func inner = (Point? p, out int) {
	if p != null {
		return p.x
	}
	return -1
}

func outer = (Point? p, out int) {
	return inner(p)
}

func test = () {
	Console.write_line("\\{outer(null)}")
	Console.write_line("\\{outer(Point(42, 0))}")
}
test()
`,
			"ns_param_forward",
			"-1\n42\n",
		);
	});

	test("nullable struct param — field access on the param", async () => {
		await build_and_check_output(
			`
struct Span {
	var int start
	var int len
}

func first = (Span? s, out int) {
	if s == null {
		return -1
	}
	return s.start
}

func second = (Span? s, out int) {
	if s == null {
		return -1
	}
	return s.len
}

func test = () {
	Console.write_line("\\{first(null)}")
	Console.write_line("\\{second(null)}")
	Console.write_line("\\{first(Span(5, 3))}")
	Console.write_line("\\{second(Span(5, 3))}")
}
test()
`,
			"ns_param_field",
			"-1\n-1\n5\n3\n",
		);
	});
});

describe("nullable struct value — ?? coalescing", () => {
	test("?? on nullable struct call result — non-null and null", async () => {
		await build_and_check_output(
			`
struct Point {
	var int x
	var int y
}

func maybe = (int x, out Point?) {
	if x > 0 {
		return Point(x, x * 2)
	}
	return null
}

func test = () {
	var Point a = maybe(5) ?? Point(0, 0)
	var Point b = maybe(0) ?? Point(99, 99)
	Console.write_line("\\{a.x}|\\{a.y}")
	Console.write_line("\\{b.x}|\\{b.y}")
}
test()
`,
			"ns_coalesce",
			"5|10\n99|99\n",
		);
	});

	test("?? on nullable struct local variable", async () => {
		await build_and_check_output(
			`
struct Point {
	var int x
	var int y
}

func test = () {
	var Point? p = null
	var Point a = p ?? Point(7, 8)
	Console.write_line("\\{a.x}|\\{a.y}")
}
test()
`,
			"ns_coalesce_local",
			"7|8\n",
		);
	});

	test("!= null check on nullable struct call result", async () => {
		await build_and_check_output(
			`
struct Point {
	var int x
	var int y
}

func maybe = (int x, out Point?) {
	if x > 0 {
		return Point(x, x)
	}
	return null
}

func test = () {
	if maybe(5) != null {
		Console.write_line("got one")
	}
	if maybe(0) == null {
		Console.write_line("got none")
	}
}
test()
`,
			"ns_call_null_check",
			"got one\ngot none\n",
		);
	});
});

describe("nullable struct value — as a struct field (regression)", () => {
	test("nullable struct field read/write through outer struct", async () => {
		// This case pre-dates the param/return fix (it's covered in
		// nullable.test.ts too) — included here as a regression check that
		// the new calling-convention changes didn't disturb field layout.
		await build_and_check_output(
			`
struct Inner {
	var int v
}
struct Outer {
	var Inner? maybe
}

func test = () {
	var Outer o = Outer(null)
	if o.maybe != null {
		Console.write_line("\\{o.maybe.v}")
	} else {
		Console.write_line("null")
	}
	o.maybe = Inner(42)
	if o.maybe != null {
		Console.write_line("\\{o.maybe.v}")
	}
}
test()
`,
			"ns_field_regression",
			"null\n42\n",
		);
	});
});
