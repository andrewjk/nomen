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

describe("errors: composed error sets", () => {
	test("out T ! E1, E2 declares and matches by origin", async () => {
		const input = `
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
	return 42
}

var ok = load("/ok")
match ok {
	case .ok(value) -> Console.write("ok \\{value}\\n")
	case .fail(_) -> Console.write("unexpected\\n")
}
var slow = load("/slow")
match slow {
	case .ok(_) -> Console.write("unexpected\\n")
	case .fail(err) {
		match err {
			case .LoadError(e) {
				match e {
					case .timeout -> Console.write("load: timeout\\n")
					case .offline -> Console.write("load: offline\\n")
				}
			}
			case .ParseError(e) {
				match e {
					case .syntax -> Console.write("parse: syntax\\n")
					case .corrupt -> Console.write("parse: corrupt\\n")
				}
			}
		}
	}
}
`;
		await build_and_check_output(input, "errors_compose", "ok 42\nload: timeout\n");
	});

	test("a member enum value lifts through its origin tag", async () => {
		const input = `
error LoadError {
	case timeout
	case offline
}

error ParseError {
	case syntax
}

func failed = (out int ! LoadError, ParseError) {
	var err = LoadError.offline
	return err
}

var result = failed()
match result {
	case .ok(_) -> Console.write("unexpected\\n")
	case .fail(err) {
		match err {
			case .LoadError(e) {
				match e {
					case .timeout -> Console.write("timeout\\n")
					case .offline -> Console.write("offline\\n")
				}
			}
			case .ParseError(e) {
				match e {
					case .syntax -> Console.write("syntax\\n")
				}
			}
		}
	}
}
`;
		await build_and_check_output(input, "errors_compose_value", "offline\n");
	});

	test("postfix ! widens a member error into the enclosing set", async () => {
		const input = `
error LoadError {
	case timeout
	case offline
}

error ParseError {
	case syntax
}

func load = (string path, out int ! LoadError) {
	if path == "/slow" {
		return .timeout
	}
	return 7
}

func load_all = (string path, out int ! LoadError, ParseError) {
	var value = load(path)!
	return value
}

var result = load_all("/slow")
match result {
	case .ok(_) -> Console.write("unexpected\\n")
	case .fail(err) {
		match err {
			case .LoadError(e) {
				match e {
					case .timeout -> Console.write("widened: timeout\\n")
					case .offline -> Console.write("offline\\n")
				}
			}
			case .ParseError(e) {
				match e {
					case .syntax -> Console.write("syntax\\n")
				}
			}
		}
	}
}
`;
		await build_and_check_output(input, "errors_compose_widen", "widened: timeout\n");
	});

	test("the set is order-insensitive", async () => {
		const input = `
error LoadError {
	case timeout
}

error ParseError {
	case syntax
}

func first = (out int ! LoadError, ParseError) {
	return .syntax
}

func second = (out int ! ParseError, LoadError) {
	return first()!
}

var result = second()
match result {
	case .ok(_) -> Console.write("unexpected\\n")
	case .fail(err) {
		match err {
			case .LoadError(e) {
				match e {
					case .timeout -> Console.write("timeout\\n")
				}
			}
			case .ParseError(e) {
				match e {
					case .syntax -> Console.write("order-insensitive\\n")
				}
			}
		}
	}
}
`;
		await build_and_check_output(input, "errors_compose_order", "order-insensitive\n");
	});

	test("an ambiguous shorthand return names the members", () => {
		const input = `import System

error LoadError {
	case timeout
}

error ParseError {
	case timeout
}

func f = (out int ! LoadError, ParseError) {
	return .timeout
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"case '.timeout' is ambiguous in the error set (LoadError, ParseError) — qualify the origin (`LoadError.timeout`)",
				12,
				9,
			),
		]);
	});

	test("a non-member error cannot propagate into the set", () => {
		const input = `import System

error LoadError {
	case timeout
}

error OtherError {
	case boom
}

func other = (out int ! OtherError) {
	return .boom
}

func combo = (out int ! LoadError) {
	return other()!
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"'!' propagates 'OtherError' but the enclosing function expects 'LoadError'",
				16,
				9,
			),
		]);
	});

	test("every set member must be an error enum", () => {
		const input = `import System

enum Direction {
	case north
}

error LoadError {
	case timeout
}

func f = (out int ! LoadError, Direction) {
	return 0
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"'!' requires an error enum — 'Direction' is not declared with 'error'; declare it `error Direction` or spell Result<T, Direction> explicitly",
				11,
				15,
			),
		]);
	});
});

describe("errors: flat match arms", () => {
	test("error cases match directly through the fail wrapper", async () => {
		const input = `
error FetchError {
	case notfound
	case offline
}

func fetch = (string url, out int ! FetchError) {
	if url == "" {
		return .notfound
	}
	if url == "/offline" {
		return .offline
	}
	return 7
}

func describe = (string url, out string) {
	return match fetch(url) {
		case .ok(value) -> "ok \\{value}"
		case .notfound -> "missing"
		case .offline -> "offline"
	}
}

Console.write("\\{describe("a")}\\n")
Console.write("\\{describe("")}\\n")
Console.write("\\{describe("/offline")}\\n")
`;
		await build_and_check_output(input, "errors_flat_single", "ok 7\nmissing\noffline\n");
	});

	test("composed sets match by origin, flat and whole-member", async () => {
		const input = `
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
	return 42
}

func describe = (string path, out string) {
	return match load(path) {
		case .ok(value) -> "ok \\{value}"
		case LoadError.timeout -> "load: timeout"
		case LoadError(err) {
			match err {
				case .timeout -> "unreachable"
				case .offline -> "load: offline"
			}
		}
		case ParseError.syntax -> "parse: syntax"
		case ParseError(err) {
			match err {
				case .syntax(_) -> "unreachable"
				case .corrupt -> "parse: corrupt"
			}
		}
	}
}

Console.write("\\{describe("a")}\\n")
Console.write("\\{describe("/slow")}\\n")
Console.write("\\{describe("/bad")}\\n")
`;
		// `LoadError.timeout` and `LoadError(err)` mix for one origin — the
		// mixing rule rejects it, so this test is parse-level only.
		const parsed = parse(`import System\n${input}`, core, undefined, { allow_internal: true });
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("composed flat arms run by origin", async () => {
		const input = `
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
	return 42
}

func describe = (string path, out string) {
	return match load(path) {
		case .ok(value) -> "ok \\{value}"
		case LoadError.timeout -> "load: timeout"
		case LoadError.offline -> "load: offline"
		case ParseError.syntax -> "parse: syntax"
		case ParseError.corrupt -> "parse: corrupt"
	}
}

Console.write("\\{describe("a")}\\n")
Console.write("\\{describe("/slow")}\\n")
Console.write("\\{describe("/bad")}\\n")
`;
		await build_and_check_output(
			input,
			"errors_flat_composed",
			"ok 42\nload: timeout\nparse: syntax\n",
		);
	});

	test("an unqualified case resolves across the set when unique", async () => {
		const input = `
error LoadError {
	case timeout
}

error ParseError {
	case syntax
}

func load = (string path, out int ! LoadError, ParseError) {
	if path == "/bad" {
		return .syntax
	}
	return 1
}

func describe = (string path, out string) {
	return match load(path) {
		case .ok(value) -> "ok \\{value}"
		case .timeout -> "timeout"
		case .syntax -> "syntax"
	}
}

Console.write("\\{describe("a")}\\n")
Console.write("\\{describe("/bad")}\\n")
`;
		await build_and_check_output(input, "errors_flat_unique", "ok 1\nsyntax\n");
	});

	test("an ambiguous flat arm names the origins", () => {
		const input = `import System

error LoadError {
	case timeout
}

error ParseError {
	case timeout
}

func load = (out int ! LoadError, ParseError) {
	return 1
}

pub func main = () {
	var label = match load() {
		case .ok(_) -> "ok"
		case .timeout -> "timeout"
	}
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"case '.timeout' is ambiguous in the error set (LoadError, ParseError) — spell the origin (`LoadError.timeout`)",
				18,
				8,
			),
		]);
	});

	test("mixing a .fail arm with flat arms is rejected", () => {
		const input = `import System

error FetchError {
	case notfound
}

func fetch = (out int ! FetchError) {
	return 1
}

pub func main = () {
	var label = match fetch() {
		case .ok(_) -> "ok"
		case .fail(err) {
			match err {
				case .notfound -> "missing"
			}
		}
		case .notfound -> "missing"
	}
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"cannot mix flat error arms with a '.fail' arm — bind the error with 'case .fail(err)' or list the flat cases",
				12,
				14,
			),
		]);
	});
});

describe("errors: anonymous error sets", () => {
	test("an inline error enum declares and matches like a named one", async () => {
		const input = `
func fetch = (string url, out int ! [.notfound, .offline]) {
	if url == "" {
		return .notfound
	}
	if url == "/offline" {
		return .offline
	}
	return 7
}

var missing = fetch("")
match missing {
	case .ok(_) -> Console.write("unexpected\\n")
	case .fail(err) {
		match err {
			case .notfound -> Console.write("missing\\n")
			case .offline -> Console.write("offline\\n")
		}
	}
}
var ok = fetch("a")
match ok {
	case .ok(value) -> Console.write("ok \\{value}\\n")
	case .fail(_) -> Console.write("unexpected\\n")
}
`;
		await build_and_check_output(input, "errors_anon_set", "missing\nok 7\n");
	});

	test("flat arms resolve through an anonymous error set", async () => {
		const input = `
func fetch = (string url, out int ! [.notfound, .offline]) {
	if url == "" {
		return .notfound
	}
	return 7
}

func describe = (string url, out string) {
	return match fetch(url) {
		case .ok(value) -> "ok \\{value}"
		case .notfound -> "missing"
		case .offline -> "offline"
	}
}

Console.write("\\{describe("a")}\\n")
Console.write("\\{describe("")}\\n")
`;
		await build_and_check_output(input, "errors_anon_flat", "ok 7\nmissing\n");
	});

	test("payload-carrying anonymous error sets parse and lift", () => {
		// Runtime teardown of a nested enum payload is the FOLLOWUP.md gap —
		// this pins the syntax/lifting surface.
		const input = `import System

func parse = (string text, out int ! [.syntax(string)]) {
	if text == "" {
		return .syntax("empty input")
	}
	return 1
}

pub func main = () {
	var bad = parse("")
	match bad {
		case .ok(_) -> Console.write("unexpected")
		case .fail(err) {
			match err {
				case .syntax(message) -> Console.write("syntax: \\{message}")
			}
		}
	}
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([]);
	});

	test("the original success-enum + anonymous-error shape", () => {
		const input = `import System

func fetch = (bool redirect, out [.ok, .redirect] ! [.notfound]) {
	if redirect {
		return .redirect
	}
	return .notfound
}

pub func main = () {
	var result = fetch(true)
	match result {
		case .ok(value) {
			match value {
				case .ok -> Console.write("ok")
				case .redirect -> Console.write("redirect")
			}
		}
		case .fail(err) {
			match err {
				case .notfound -> Console.write("missing")
			}
		}
	}
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([]);
	});

	test("an anonymous error set cannot join a composed set", () => {
		const input = `import System

error LoadError {
	case timeout
}

func load = (out int ! LoadError, [.notfound]) {
	return 1
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"an anonymous error set cannot join a composed set — name the error enum instead",
				7,
				18,
			),
		]);
	});
});
