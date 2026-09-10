import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("must_use enums", () => {
	test("declaration forms: `pub must_use enum`, `must_use enum`, `must_use pub enum`", () => {
		const input = `
pub must_use enum A {
	case ok
	case error(int code)
}

must_use enum B {
	case ok
	case error(int code)
}

must_use pub enum C {
	case ok
	case error(int code)
}

func use = (out A) {
	return A.ok
}
var _ = use()
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("binding, matching, and explicit discard all compile and run", async () => {
		const input = `
pub must_use enum Attempt {
	case ok
	case error(int code)
}

func try_it = (int n, out Attempt) {
	if n > 0 {
		return Attempt.ok
	}
	return Attempt.error(n)
}

var _ = try_it(1)
var _ = try_it(-1)
match try_it(3) {
	case .ok {
		Console.write("ok")
	}
	case .error(code) {
		Console.write("error \\{code}")
	}
}
`;
		await build_and_check_output(input, "strict_enum_use", "ok");
	});

	test("bare statement call discarding a must_use enum is an error (method call)", () => {
		const input = `
pub must_use enum Attempt {
	case ok
	case error(int code)
}

func try_it = (out Attempt) {
	return Attempt.error(5)
}

try_it()
`;
		const parsed = parse_with_imports(input);
		expect(
			parsed.errors.some((e) => e.message.includes("Value of must_use enum Attempt is discarded")),
		).toBe(true);
	});

	test("bare statement call discarding a must_use enum is an error (free function call)", () => {
		const input = `
pub must_use enum Attempt {
	case ok
	case error(int code)
}

func attempt = (out Attempt) {
	return Attempt.error(5)
}

attempt()
`;
		const parsed = parse_with_imports(input);
		expect(
			parsed.errors.some((e) => e.message.includes("Value of must_use enum Attempt is discarded")),
		).toBe(true);
	});

	test("`let`-prefixed calls discard too and are rejected", () => {
		const input = `
pub must_use enum Attempt {
	case ok
	case error(int code)
}

func try_it = (out Attempt) {
	return Attempt.error(5)
}

let try_it()
`;
		const parsed = parse_with_imports(input);
		expect(
			parsed.errors.some((e) => e.message.includes("Value of must_use enum Attempt is discarded")),
		).toBe(true);
	});

	test("non-must_use enums may still be discarded", () => {
		const input = `
pub enum Attempt {
	case ok
	case error(int code)
}

func try_it = (out Attempt) {
	return Attempt.error(5)
}

try_it()
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("core Result is must_use: a discarded File op errors, `var _` and match are uses", async () => {
		const input = `
var File w = File()
match w.open("strict_enum_file.txt", "w") {
	case .ok(did) {
		var _ = w.writeAll("strict")
		var _ = w.close()
	}
	case .error(e) {
		Console.write("open failed")
	}
}

var File r = File()
var _ = r.open("strict_enum_file.txt", "r")
match r.readAll() {
	case .ok(text) {
		Console.write(text)
	}
	case .error(e) {
		Console.write("read failed")
	}
}
var _ = r.close()
`;
		await build_and_check_output(input, "strict_enum_file", "strict");
	});

	test("core Result mono discard error names the generic spelling", () => {
		const input = `
func try_it = (out Result<int, string>) {
	return Result.error("no")
}

try_it()
`;
		const parsed = parse_with_imports(input);
		expect(
			parsed.errors.some((e) =>
				e.message.includes("Value of must_use enum Result<int, string> is discarded"),
			),
		).toBe(true);
	});

	test("repeated `var _` discards in one scope compile and run", async () => {
		const input = `
pub must_use enum Attempt {
	case ok
	case error(int code)
}

func try_it = (out Attempt) {
	return Attempt.ok
}

var _ = try_it()
var _ = try_it()
var _ = try_it()
Console.write("done")
`;
		await build_and_check_output(input, "strict_enum_repeated_discard", "done");
	});

	test("`must_use` remains usable as an identifier", () => {
		const input = `
var int must_use = 3
must_use = must_use + 1
Console.write("\\{must_use}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});

describe("must_use bitsets", () => {
	test("declaration forms and binding compile", () => {
		const input = `
pub must_use bitset Flags {
	case read
	case write
}

must_use bitset Quiet {
	case on
	case off
}

func flags_of = (out Flags) {
	return Flags.read | Flags.write
}

var _ = flags_of()
const f = flags_of()
Console.write("\\{f}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("bare statement call discarding a must_use bitset is an error", () => {
		const input = `
pub must_use bitset Flags {
	case read
	case write
}

func flags_of = (out Flags) {
	return Flags.read | Flags.write
}

flags_of()
`;
		const parsed = parse_with_imports(input);
		expect(
			parsed.errors.some((e) => e.message.includes("Value of must_use bitset Flags is discarded")),
		).toBe(true);
	});

	test("non-must_use bitsets may still be discarded", () => {
		const input = `
pub bitset Flags {
	case read
	case write
}

func flags_of = (out Flags) {
	return Flags.read | Flags.write
}

flags_of()
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});
