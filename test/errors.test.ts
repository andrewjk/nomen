import { describe, expect, test } from "vite-plus/test";

import parse from "../src/parse.ts";
import build_and_check_output from "./build_and_check_output.ts";
import { compile_module, core } from "./spec/_helpers.ts";
import test_error from "./test_error.ts";

describe("errors: the `error` declaration", () => {
	test("an error enum declares and matches like an enum", async () => {
		const input = `
error FetchError {
	case notfound
}

func fetch = (string url, out Result<string, FetchError>) {
	if url == "" {
		return .fail(.notfound)
	}
	return .ok("body of \\{url}")
}

var ok_result = fetch("example.com")
match ok_result {
	case .ok(body) -> Console.write("\\{body}\\n")
	case .fail(_) -> Console.write("failed\\n")
}
`;
		await build_and_check_output(input, "errors_declare", "body of example.com\n");
	});

	test("a payload-carrying error enum takes the mv spelling", async () => {
		const input = `
mv error MyError {
	case dns
	case refused(int code)
}

func fetch = (string url, out Result<string, MyError>) {
	if url == "" {
		return .fail(.refused(7))
	}
	return .ok("body")
}

var result = fetch("")
match result {
	case .ok(_) -> Console.write("unexpected\\n")
	case .fail(err) {
		match err {
			case .refused(code) -> Console.write("refused \\{code}\\n")
			case .dns -> Console.write("dns\\n")
		}
	}
}
`;
		await build_and_check_output(input, "errors_mv_declare", "refused 7\n");
	});

	test("error enums are always checked: a statement-position discard is an error", () => {
		const input = `import System

error FetchError {
	case notfound
}

func fetch = (out Result<int, FetchError>) {
	return .ok(5)
}

pub func main = () {
	fetch()
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"Value of checked enum Result<int, FetchError> is discarded; bind it (e.g. `var _ = …`) or match on it",
				12,
				2,
			),
		]);
	});

	test("`var _ =` is the deliberate discard", () => {
		const input = `
error FetchError {
	case notfound
}

func fetch = (out Result<int, FetchError>) {
	return .ok(5)
}

var _ = fetch()
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("`error` is a reserved word", () => {
		const input = `import System

pub func main = () {
	var error = 5
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(input, "'error' is a reserved word and cannot be used as a name", 4, 6),
		]);
	});
});

describe("errors: the `T ! E` result form", () => {
	test("a bare return of the success type lifts to .ok", async () => {
		const input = `
error FetchError {
	case notfound
}

func fetch = (string url, out string ! FetchError) {
	return "body of \\{url}"
}

var result = fetch("example.com")
match result {
	case .ok(body) -> Console.write("\\{body}\\n")
	case .fail(_) -> Console.write("failed\\n")
}
`;
		await build_and_check_output(input, "errors_lift_ok", "body of example.com\n");
	});

	test("a shorthand case of the error enum lifts to .fail", async () => {
		const input = `
error FetchError {
	case notfound
}

func fetch = (string url, out string ! FetchError) {
	if url == "" {
		return .notfound
	}
	return .ok("body")
}

var missing = fetch("")
match missing {
	case .ok(_) -> Console.write("unexpected\\n")
	case .fail(err) {
		match err {
			case .notfound -> Console.write("notfound\\n")
		}
	}
}
`;
		await build_and_check_output(input, "errors_lift_fail", "notfound\n");
	});

	test("a value of the error enum type lifts to .fail", async () => {
		const input = `
error FetchError {
	case notfound
}

func inner = (out FetchError) {
	return .notfound
}

func fetch = (out string ! FetchError) {
	var err = inner()
	return err
}

var result = fetch()
match result {
	case .ok(_) -> Console.write("unexpected\\n")
	case .fail(err) {
		match err {
			case .notfound -> Console.write("fail: notfound\\n")
		}
	}
}
`;
		await build_and_check_output(input, "errors_lift_value", "fail: notfound\n");
	});

	test("an explicit Result value passes through unlifted", async () => {
		const input = `
error FetchError {
	case notfound
}

func fetch = (out string ! FetchError) {
	return .fail(.notfound)
}

var result = fetch()
match result {
	case .ok(_) -> Console.write("unexpected\\n")
	case .fail(_) -> Console.write("explicit fail\\n")
}
`;
		await build_and_check_output(input, "errors_explicit", "explicit fail\n");
	});

	test("an arrow body lifts like any return", async () => {
		const input = `
error FetchError {
	case notfound
}

func fetch = (string url, out string ! FetchError) => url + "!"

var result = fetch("hey")
match result {
	case .ok(body) -> Console.write("\\{body}\\n")
	case .fail(_) -> Console.write("failed\\n")
}
`;
		await build_and_check_output(input, "errors_lift_arrow", "hey!\n");
	});

	test("the `!` grammar rejects a non-error enum with a teaching error", () => {
		const input = `import System

enum Direction {
	case north
}

func fetch = (out string ! Direction) {
	return "x"
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"'!' requires an error enum — 'Direction' is not declared with 'error'; declare it `error Direction` or spell Result<T, Direction> explicitly",
				7,
				19,
			),
		]);
	});

	test("`void` cannot be a '!' result type", () => {
		const input = `import System

error FetchError {
	case notfound
}

func close = (out void ! FetchError) {
	return
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"'void' cannot be a '!' result type — spell the success type instead",
				7,
				19,
			),
		]);
	});

	test("an explicit Result<T, E> return type keeps explicit behavior", () => {
		const input = `import System

error FetchError {
	case notfound
}

func fetch = (out Result<string, FetchError>) {
	return "bare value does not lift here"
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});

describe("errors: the `!!` result coalesce", () => {
	test("the ok path yields the payload, the fail path the fallback", async () => {
		const input = `
error FetchError {
	case notfound
}

func fetch = (string url, out string ! FetchError) {
	if url == "" {
		return .notfound
	}
	return "body of \\{url}"
}

var ok_body = fetch("example.com") !! "fallback"
Console.write("\\{ok_body}\\n")
var failed = fetch("") !! "fallback"
Console.write("\\{failed}\\n")
`;
		await build_and_check_output(input, "errors_coalesce", "body of example.com\nfallback\n");
	});

	test("the fallback may be any T expression, including a call", async () => {
		const input = `
error FetchError {
	case notfound
}

func fetch = (string url, out int ! FetchError) {
	if url == "" {
		return .notfound
	}
	return 7
}

func default_size = (out int) {
	return 42
}

Console.write("\\{fetch("u") !! 0}\\n")
Console.write("\\{fetch("") !! default_size()}\\n")
`;
		await build_and_check_output(input, "errors_coalesce_call", "7\n42\n");
	});

	test("every string ownership shape stays balanced under the audit", async () => {
		const input = `
error FetchError {
	case notfound
}

func fetch = (string url, out string ! FetchError) {
	if url == "" {
		return .notfound
	}
	return "body of \\{url}"
}

func other_string = (out string) {
	return "from call"
}

var stored = fetch("u")
var from_var = stored !! "var fallback"
Console.write("\\{from_var}\\n")
Console.write("\\{stored !! other_string()}\\n")
Console.write("\\{stored !! "lit"}\\n")
Console.write("\\{fetch("v") !! "lit"}\\n")
Console.write("\\{fetch("") !! "lit"}\\n")
`;
		await build_and_check_output(
			input,
			"errors_coalesce_ownership",
			"body of u\nbody of u\nbody of u\nbody of v\nlit\n",
		);
	});

	test("the same coalesce runs on the JS backend", async () => {
		const input = `
error FetchError {
	case notfound
}

func fetch = (string url, out string ! FetchError) {
	if url == "" {
		return .notfound
	}
	return "body"
}

Console.write("\\{fetch("a") !! "fb"}\\n")
Console.write("\\{fetch("") !! "fb"}\\n")
`;
		await build_and_check_output(input, "errors_coalesce_js", "body\nfb\n", false, {
			js: true,
		});
	});

	test("`!!` rejects a non-result left operand", () => {
		const input = `import System

pub func main = () {
	var x = 5 !! 0
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"'!!' needs a 'T ! E' result on the left — 'int' is not a result type",
				4,
				10,
			),
		]);
	});

	test("`!!` rejects a fallback of the wrong type", () => {
		const input = `import System

error FetchError {
	case notfound
}

func fetch = (string u, out string ! FetchError) {
	return u
}

pub func main = () {
	var s = fetch("u") !! 0
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"the '!!' fallback must be the result's success type ('string') — got 'int'",
				12,
				24,
			),
		]);
	});
});

describe("errors: postfix `!` propagation", () => {
	test("the fail case returns from the enclosing function, the ok case yields", async () => {
		const input = `
error FetchError {
	case notfound
	case denied
}

func load = (string path, out int ! FetchError) {
	if path == "" {
		return .notfound
	}
	if path == "/private" {
		return .denied
	}
	return 7
}

func load_and_double = (string path, out int ! FetchError) {
	var value = load(path)!
	return value * 2
}

var ok = load_and_double("config.txt")
match ok {
	case .ok(value) -> Console.write("\\{value}\\n")
	case .fail(_) -> Console.write("unexpected\\n")
}
var failed = load_and_double("")
match failed {
	case .ok(_) -> Console.write("unexpected\\n")
	case .fail(err) {
		match err {
			case .notfound -> Console.write("propagated: notfound\\n")
			case .denied -> Console.write("propagated: denied\\n")
		}
	}
}
var denied = load_and_double("/private")
match denied {
	case .ok(_) -> Console.write("unexpected\\n")
	case .fail(err) {
		match err {
			case .notfound -> Console.write("wrong arm\\n")
			case .denied -> Console.write("propagated: denied\\n")
		}
	}
}
`;
		await build_and_check_output(
			input,
			"errors_propagate",
			"14\npropagated: notfound\npropagated: denied\n",
		);
	});

	test("a return-position propagation composes call chains", async () => {
		const input = `
error FetchError {
	case notfound
}

func load = (string path, out int ! FetchError) {
	if path == "" {
		return .notfound
	}
	return 5
}

func outer = (string path, out int ! FetchError) {
	return load(path)!
}

var result = outer("")
match result {
	case .ok(_) -> Console.write("unexpected\\n")
	case .fail(err) {
		match err {
			case .notfound -> Console.write("chain propagated\\n")
		}
	}
}
`;
		await build_and_check_output(input, "errors_propagate_return", "chain propagated\n");
	});

	test("`!` outside a fallible function is an error", () => {
		const input = `import System

error FetchError {
	case notfound
}

func load = (out Result<int, FetchError>) {
	return .ok(1)
}

pub func main = () {
	var x = load()!
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"'!' propagates to the caller — the enclosing function must declare a '!' result type",
				12,
				10,
			),
		]);
	});

	test("`!` on a non-result value is an error", () => {
		const input = `import System

error FetchError {
	case notfound
}

pub func main = () {
	var x = 5
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([]);
	});
});
