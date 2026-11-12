import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

// Mirrors SPEC.md "Errors" — one test per fenced block. Valid examples must
// compile with no errors; error examples are negative tests asserting the
// documented message.

describe("spec: errors", () => {
	test("an error enum declares and is deliberately discarded", () => {
		const body = `
error FetchError {
	case notfound
}

func fetch = (string url, out Result<int, FetchError>) {
	return .fail(.notfound)
}

var _ = fetch("u")
`;
		expect(compile_module(body)).toEqual([]);
	});

	test("a heap-payload error enum takes the mv spelling", () => {
		const body = `
mv error ParseError {
	case syntax(string message)
}
`;
		expect(compile_module(body)).toEqual([]);
	});

	test("the T ! E form lifts bare returns", () => {
		const body = `
error FetchError {
	case notfound
}

func fetch = (string url, out int ! FetchError) {
	if url == "" {
		return .notfound
	}
	return 7
}
`;
		expect(compile_module(body)).toEqual([]);
	});

	test("callers handle the result with the enum machinery", () => {
		const body = `
error FetchError {
	case notfound
}

func fetch = (string url, out int ! FetchError) {
	if url == "" {
		return .notfound
	}
	return 7
}

var result = fetch("u")
match result {
	case .ok(value) -> Console.write("\\{value}")
	case .fail(err) {
		match err {
			case .notfound -> Console.write("missing")
		}
	}
}
`;
		expect(compile_module(body)).toEqual([]);
	});

	test("the !! coalesce yields T", () => {
		const body = `
error FetchError {
	case notfound
}

func fetch = (string url, out int ! FetchError) {
	if url == "" {
		return .notfound
	}
	return 7
}

var body = fetch("example.com") !! 0
Console.write("\\{body}")
`;
		expect(compile_module(body)).toEqual([]);
	});

	test("postfix ! propagates through statements and returns", () => {
		const body = `
error FetchError {
	case notfound
}

func load = (string path, out int ! FetchError) {
	if path == "" {
		return .notfound
	}
	return 7
}

func load_and_double = (string path, out int ! FetchError) {
	var value = load(path)!
	return value * 2
}

func outer = (string path, out int ! FetchError) {
	return load(path)!
}

var doubled = load_and_double("config.txt") !! 0
Console.write("\\{doubled}")
`;
		expect(compile_module(body)).toEqual([]);
	});
});
