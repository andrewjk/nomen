import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("spec: anonymous enums", () => {
	test("parse and return", () => {
		const input = `
func parse_age = (string s, out [.ok(int), .error(string)]) {
    return .error("not a number")
}

var [.ok(int), .error(string)] result = .ok(42)
match result {
    case .ok(age) -> Console.write("\\{age}")
    case .error(msg) -> Console.write("error \\{msg}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("parameter type and no-payload case", () => {
		const input = `
func describe = ([.some(int), .none] opt, out string) {
    return match opt {
        case .some(v) -> "some"
        case .none -> "none"
    }
}

Console.write(describe(.none))
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: generic enums", () => {
	test("declaration with type parameters", () => {
		const input = `
pub enum Result<T, E> {
    case ok(T value)
    case error(E error)
}

var Result<int, string> result = .error("not a number")
match result {
    case .ok(age) -> Console.write("\\{age}")
    case .error(msg) -> Console.write("error \\{msg}")
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("full form construction and shorthand reassignment", () => {
		const input = `
var Option<int> found = Option.some(4)
found = .none
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("core Result and Option are available from System", () => {
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
    case .some(v) -> Console.write("\\{v}")
    case .none -> Console.write("none")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("core Result is must_use: discard is an error, binding is a use", () => {
		const fallible = `
func try_it = (out Result<int, string>) {
    return Result.error("no")
}
`;
		const ok = compile_main(`${fallible}
var _ = try_it()
`);
		expect(ok).toEqual([]);

		const discarded = compile_main(`${fallible}
try_it()
`);
		expect(
			discarded.some((e) =>
				e.message.includes("Value of must_use enum Result<int, string> is discarded"),
			),
		).toBe(true);
	});
});
