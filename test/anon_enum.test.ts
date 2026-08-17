import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("anonymous enums", () => {
	test("declaration, shorthand and match", async () => {
		const input = `
func parse_age = (string s, out [.ok(int), .error(string)]) {
    return .ok(42)
}

var [.ok(int), .error(string)] result = .error("bad input")
result = .ok(7)
match result {
    case .ok(age) -> Console.write("ok \\{age}\\n")
    case .error(msg) -> Console.write("error \\{msg}\\n")
}

const r2 = parse_age("x")
match r2 {
    case .ok(code) -> Console.write("\\{code}\\n")
    case .error -> Console.write("err\\n")
}
`;
		await build_and_check_output(input, "anon_enum_basic", "ok 7\n42\n");
	});

	test("case order is irrelevant to identity", async () => {
		const input = `
func make = (out [.error, .ok(int)]) {
    return .ok(9)
}

var [.ok(int), .error] a = .error
var [.error, .ok(int)] b = .ok(3)
a = .ok(1)
match a {
    case .ok(n) -> Console.write("a=\\{n}\\n")
    case .error -> Console.write("a=e\\n")
}
match b {
    case .ok(n) -> Console.write("ok\\{n}\\n")
    case .error -> Console.write("e\\n")
}
`;
		await build_and_check_output(input, "anon_enum_order", "a=1\nok3\n");
	});

	test("as parameter type with payload match", async () => {
		const input = `
func describe = ([.some(int), .none] opt, out string) {
    return match opt {
        case .some(v) -> "some"
        case .none -> "none"
    }
}

Console.write(describe(.some(5)))
Console.write("\\n")
Console.write(describe(.none))
Console.write("\\n")
`;
		await build_and_check_output(input, "anon_enum_param", "some\nnone\n");
	});

	test("errors: shorthand without type hint", () => {
		const input = `
var r = .ok(5)
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Cannot resolve .ok without a type hint");
	});

	test("errors: unknown case against annotation", () => {
		const input = `
var [.ok(int), .error] r = .oops
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Unknown enum case: .oops");
	});

	test("errors: wrong case arity", () => {
		const input = `
var [.ok(int), .error] r = .ok()
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("expects 1 arguments, got 0");
	});

	test("errors: duplicate case", () => {
		const input = `
var [.ok(int), .ok(string)] r = .ok(5)
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Duplicate enum case: ok");
	});

	test("errors: non-exhaustive match", () => {
		const input = `
var [.ok(int), .error] r = .ok(5)
match r {
    case .ok(n) -> Console.write(n)
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Non-exhaustive match");
	});

	test("errors: unknown payload type", () => {
		const input = `
var [.ok(int), .error(NoSuchType)] r = .error
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Unknown type");
	});
});

describe("generic enums", () => {
	test("core Result shorthand", async () => {
		const input = `
func parse_age = (string s, out Result<int, string>) {
    return .error("not a number")
}

const result = parse_age("x")
match result {
    case .ok(age) -> Console.write("\\{age}\\n")
    case .error(msg) -> Console.write("error: \\{msg}\\n")
}
`;
		await build_and_check_output(input, "generic_enum_result", "error: not a number\n");
	});

	test("core Option with full form construction", async () => {
		const input = `
func find = (int[] xs, out Option<int>) {
    for x of xs {
        if x % 2 == 0 {
            return Option.some(x)
        }
    }
    return .none
}

var Option<int> found = find([1, 3, 4])
match found {
    case .some(v) -> Console.write("some \\{v}\\n")
    case .none -> Console.write("none\\n")
}
found = Option.some(10)
match found {
    case .some(v) -> Console.write("\\{v}\\n")
    case .none -> Console.write("none\\n")
}
`;
		await build_and_check_output(input, "generic_enum_option", "some 4\n10\n");
	});

	test("two monomorphizations of the same generic enum", async () => {
		const input = `
var Result<int, string> ri = .ok(1)
var Result<bool, int> rb = .error(3)
match ri {
    case .ok(n) -> Console.write("i\\{n}\\n")
    case .error(s) -> Console.write(s)
}
match rb {
    case .ok(b) -> Console.write("ok\\n")
    case .error(c) -> Console.write("e\\{c}\\n")
}
`;
		await build_and_check_output(input, "generic_enum_two_monos", "i1\ne3\n");
	});

	test("errors: generic enum without type arguments", () => {
		const input = `
var Result r = .ok(5)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("requires type arguments");
	});
});
