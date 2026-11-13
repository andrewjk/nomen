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

	test("a composed error set declares and lifts by origin", () => {
		const body = `
error LoadError {
	case timeout
	case offline
}

error ParseError {
	case syntax
}

func load = (string path, out int ! LoadError, ParseError) {
	if path == "/slow" {
		return .timeout
	}
	if path == "/bad" {
		return .syntax
	}
	return 7
}
`;
		expect(compile_module(body)).toEqual([]);
	});

	test("postfix ! widens a member error into the enclosing set", () => {
		const body = `
error LoadError {
	case timeout
	case offline
}

error ParseError {
	case syntax
}

func load = (string path, out int ! LoadError, ParseError) {
	if path == "/slow" {
		return .timeout
	}
	if path == "/bad" {
		return .syntax
	}
	return 7
}

func load_all = (string path, out int ! LoadError, ParseError) {
	var value = load(path)!
	return value
}

var result = load_all("/slow")
match result {
	case .ok(value) -> Console.write("\\{value}")
	case .fail(err) {
		match err {
			case .LoadError(e) {
				match e {
					case .timeout -> Console.write("timeout")
					case .offline -> Console.write("offline")
				}
			}
			case .ParseError(e) {
				match e {
					case .syntax -> Console.write("syntax")
				}
			}
		}
	}
}
`;
		expect(compile_module(body)).toEqual([]);
	});

	test("try/catch handles the error side, success flows through", () => {
		const body = `
error FetchError {
	case notfound
	case offline
}

func fetch = (string url, out string ! FetchError) {
	if url == "" {
		return .notfound
	}
	return "content:" + url
}

var label = try fetch("u") catch {
	case .notfound -> "missing"
	case .offline -> "offline"
}
`;
		expect(compile_module(body)).toEqual([]);
	});

	test("composed catch arms may name the origin", () => {
		const body = `
error LoadError {
	case timeout
	case offline
}

error ParseError {
	case syntax
	case corrupt
}

func load = (string path, out int ! LoadError, ParseError) {
	if path == "/slow" {
		return .timeout
	}
	if path == "/bad" {
		return .syntax
	}
	return 7
}

func describe = (string path, out int) {
	return try load(path) catch {
		case LoadError.timeout -> -1
		case LoadError.offline -> -2
		case ParseError.syntax -> -3
		case ParseError.corrupt -> -4
	}
}
`;
		expect(compile_module(body)).toEqual([]);
	});

	test("an anonymous error set declares and lifts", () => {
		const body = `
func fetch = (string url, out int ! [.notfound, .offline]) {
	if url == "" {
		return .notfound
	}
	if url == "/offline" {
		return .offline
	}
	return 7
}

var result = fetch("")
match result {
	case .ok(value) -> Console.write("\\{value}")
	case .fail(err) {
		match err {
			case .notfound -> Console.write("missing")
			case .offline -> Console.write("offline")
		}
	}
}
`;
		expect(compile_module(body)).toEqual([]);
	});

	test("the unit result form declares, falls through, and matches", () => {
		const body = `
error FetchError {
	case notfound
}

func close = (string path, out ! FetchError) {
	if path == "" {
		return .notfound
	}
	// falls through: success
}

func describe = (string path, out string) {
	return match close(path) {
		case .ok -> "closed"
		case .fail(err) {
			match err {
				case .notfound -> "missing"
			}
		}
	}
}
`;
		expect(compile_module(body)).toEqual([]);
	});

	test("a unit-result function propagates with postfix !", () => {
		const body = `
error FetchError {
	case notfound
}

func close = (string path, out ! FetchError) {
	if path == "" {
		return .notfound
	}
}

func cleanup = (string path, out ! FetchError) {
	close(path)!        // propagate; success yields nothing
	var _ = close(path)
}
`;
		expect(compile_module(body)).toEqual([]);
	});
});
