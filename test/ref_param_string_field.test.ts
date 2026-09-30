import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

// A store to a string field through a `ref` struct param writes caller-owned
// storage, but heap_string_fields records are scope-local — the callee's
// record used to die at return, so the stored copy leaked (FOLLOWUP.md,
// "Cross-scope string field stores"). The call-site record transfer
// (transfer_ref_param_field_records) now attributes the callee's direct
// stores to the caller's variable, so every shape here is audit-balanced.

function run(input: string, name: string, expected: string, audit = true) {
	return async () => {
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit });
		await check_output(name, result, expected, { arch: "aarch64", audit });
	};
}

describe("string field store through a ref struct param", () => {
	test(
		"field survives the callee; the local keeps its own copy",
		run(
			`
import System

struct Box {
	var string s = ""
}

func fill = (ref Box dst) {
	var string s = "abc123".substring(0, 3)
	dst.s = s
	Console.write("callee sees [" + s + "]\\n")
}

pub func main = (Init init) {
	var Box b = Box()
	fill(ref b)
	Console.write("caller sees [" + b.s + "]\\n")
}
`,
			"ref_param_field_local_string",
			"callee sees [abc]\ncaller sees [abc]\n",
		),
	);

	test(
		"reassignment displaces the previous heap value",
		run(
			`
import System

struct Box {
	var string s = ""
}

func fill_two = (ref Box dst) {
	var string first = "first".to_string()
	var string second = "second".to_string()
	dst.s = first
	dst.s = second
}

pub func main = (Init init) {
	var Box b = Box()
	fill_two(ref b)
	Console.write("[" + b.s + "]\\n")
}
`,
			"ref_param_field_reassign",
			"[second]\n",
		),
	);

	test(
		"a fresh call-result store through the ref param",
		run(
			`
import System

struct Box {
	var string s = ""
}

func fill = (ref Box dst, string raw) {
	dst.s = raw.substring(0, 2)
}

pub func main = (Init init) {
	var Box b = Box()
	fill(ref b, "hello")
	Console.write("[" + b.s + "]\\n")
}
`,
			"ref_param_field_call_result",
			"[he]\n",
		),
	);

	test(
		"same-scope store is audit-balanced end to end",
		run(
			`
import System

struct Box {
	var string s = ""
}

pub func main = (Init init) {
	var Box b = Box()
	var string s = "abc123".substring(0, 3)
	b.s = s
	Console.write("[" + b.s + "]\\n")
}
`,
			"ref_param_field_same_scope",
			"[abc]\n",
			true,
		),
	);

	test(
		"class targets keep working alongside the fix",
		run(
			`
import System

class Box2 {
	var string s

	func #init = (ref self, string v) {
		self.s = v
	}
}

func fill_class = (ref Box2 dst) {
	var string s = "hey".to_string()
	dst.s = s
}

pub func main = (Init init) {
	var Box2 b = Box2("init")
	fill_class(ref b)
	Console.write("[" + b.s + "]\\n")
}
`,
			"ref_param_field_class_target",
			"[hey]\n",
			true,
		),
	);
});
