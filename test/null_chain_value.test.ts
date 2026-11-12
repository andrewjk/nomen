import { describe, expect, test } from "vite-plus/test";

import build from "../src/build.ts";
import parse from "../src/parse.ts";
import build_and_check_output from "./build_and_check_output.ts";
import { core } from "./spec/_helpers.ts";

describe("nullable chaining as a value (`?.` v2)", () => {
	test("a chain initializes a nullable string local on both arms", async () => {
		const input = `
mv struct Profile {
	var string nickname
}

func find = (int id, out Profile?) {
	if id == 1 {
		return Profile("ada")
	}
	return null
}

var p = find(1)
var nick = p?.nickname
Console.write("\\{nick ?? "none"}\\n")
var q = find(2)
var none = q?.nickname
Console.write("\\{none ?? "none"}\\n")
`;
		await build_and_check_output(input, "null_chain_decl_string", "ada\nnone\n");
	});

	test("a chain initializes a nullable scalar local on both arms", async () => {
		const input = `
struct Profile {
	var int score
}

func find = (int id, out Profile?) {
	if id == 1 {
		return Profile(5)
	}
	return null
}

var p = find(1)
var s = p?.score
Console.write("\\{s ?? 0}\\n")
var q = find(2)
var t = q?.score
Console.write("\\{t ?? 0}\\n")
`;
		await build_and_check_output(input, "null_chain_decl_scalar", "5\n0\n");
	});

	test("a chain assigns through a nullable local on both arms", async () => {
		const input = `
struct Profile {
	var int score
}

func find = (int id, out Profile?) {
	if id == 1 {
		return Profile(5)
	}
	return null
}

var p = find(2)
var int? s = null
s = p?.score
Console.write("\\{s ?? -1}\\n")
var q = find(1)
s = q?.score
Console.write("\\{s ?? -1}\\n")
`;
		await build_and_check_output(input, "null_chain_assign", "-1\n5\n");
	});

	test("a chain returns a nullable scalar (the flag rides `_ret_has`)", async () => {
		const input = `
struct Profile {
	var int score
}

func find = (int id, out Profile?) {
	if id == 1 {
		return Profile(5)
	}
	return null
}

func score_of = (int id, out int?) {
	var p = find(id)
	return p?.score
}

Console.write("\\{score_of(1) ?? -1}\\n")
Console.write("\\{score_of(2) ?? -1}\\n")
`;
		await build_and_check_output(input, "null_chain_return_scalar", "5\n-1\n");
	});

	test("a chain returns a nullable string", async () => {
		const input = `
mv struct Profile {
	var string nickname
}

func find = (int id, out Profile?) {
	if id == 1 {
		return Profile("ada")
	}
	return null
}

func nick_of = (int id, out string?) {
	var p = find(id)
	return p?.nickname
}

var a = nick_of(1)
Console.write("\\{a ?? "none"}\\n")
var b = nick_of(2)
Console.write("\\{b ?? "none"}\\n")
`;
		// The result is consumed through a local (an owned pair either way);
		// the `f() ?? fb` spelling on a nullable-string CALL leaks on main
		// (FOLLOWUP) — this test pins the transfer-into-local shape.
		await build_and_check_output(input, "null_chain_return_string", "ada\nnone\n");
	});

	test("a chain passes a nullable argument (the flag rides the companion param)", async () => {
		const input = `
struct Profile {
	var int score
}

func find = (int id, out Profile?) {
	if id == 1 {
		return Profile(5)
	}
	return null
}

func show = (int? s) {
	Console.write("\\{s ?? -1}\\n")
}

var p = find(1)
show(p?.score)
var q = find(2)
show(q?.score)
`;
		await build_and_check_output(input, "null_chain_arg", "5\n-1\n");
	});

	test("a method-call hop (`p?.greet(...)`) calls only on the non-null path", async () => {
		const input = `
mv struct Profile {
	var string nickname
	func greet = (self, string w, out string) {
		return "\\{w} \\{self.nickname}"
	}
}

func find = (int id, out Profile?) {
	if id == 1 {
		return Profile("ada")
	}
	return null
}

var p = find(1)
Console.write("\\{p?.greet("hi") ?? "none"}\\n")
var q = find(2)
Console.write("\\{q?.greet("hi") ?? "none"}\\n")
`;
		await build_and_check_output(input, "null_chain_method_hop", "hi ada\nnone\n");
	});

	test("a chain through a call base evaluates the base once", async () => {
		const input = `
struct Inner {
	var int value
}

struct Outer {
	var Inner inner
}

func mk = (int v, out Outer?) {
	if v > 0 {
		return Outer(Inner(v))
	}
	return null
}

Console.write("\\{mk(7)?.inner.value ?? -1}\\n")
Console.write("\\{mk(0)?.inner.value ?? -1}\\n")
`;
		await build_and_check_output(input, "null_chain_call_base", "7\n-1\n");
	});

	test("a chain through a method hop continues on its result", async () => {
		const input = `
struct Inner {
	var int value
}

struct Box {
	var Inner inner
	func get = (self, out Inner) {
		return self.inner
	}
}

func mk = (int v, out Box?) {
	if v > 0 {
		return Box(Inner(v))
	}
	return null
}

Console.write("\\{mk(7)?.get().value ?? -1}\\n")
Console.write("\\{mk(0)?.get().value ?? -1}\\n")
`;
		await build_and_check_output(input, "null_chain_method_then_field", "7\n-1\n");
	});

	test("a chain whose final member is itself nullable tests the member's flag", async () => {
		const input = `
struct Inner {
	var int? tag
}

struct Outer {
	var Inner inner
}

func mk = (int v, out Outer?) {
	if v > 0 {
		return Outer(Inner(v))
	}
	return null
}

var a = mk(7)
Console.write("\\{a?.inner.tag ?? -1}\\n")
var b = mk(0)
Console.write("\\{b?.inner.tag ?? -1}\\n")
`;
		// The last hop is a plain `.` onto a nullable field — its own `_has`
		// flag joins the chain's hop tests, so a null tag takes the fallback.
		await build_and_check_output(input, "null_chain_nullable_member", "7\n-1\n");
	});

	test("a null tag on the final member takes the fallback", async () => {
		const input = `
struct Inner {
	var int? tag
}

struct Outer {
	var Inner inner
}

func mk = (out Outer?) {
	return Outer(Inner(null))
}

var a = mk()
Console.write("\\{a?.inner.tag ?? -2}\\n")
`;
		await build_and_check_output(input, "null_chain_null_tag", "-2\n");
	});

	test("a chain returns a nullable struct member (the flag rides sret)", async () => {
		const input = `
struct Val {
	var int v
}

struct Holder {
	var Val val
}

func mk = (int v, out Holder?) {
	if v > 0 {
		return Holder(Val(v))
	}
	return null
}

func val_of = (int v, out Val?) {
	var h = mk(v)
	return h?.val
}

Console.write("\\{val_of(5)?.v ?? 0}\\n")
Console.write("\\{val_of(0)?.v ?? 0}\\n")
`;
		await build_and_check_output(input, "null_chain_return_struct", "5\n0\n");
	});

	test("a chain in a return position compiles with no errors (was a v1 build error)", () => {
		const input = `
struct Profile {
	var int score
}
func find = (int id, out Profile?) {
	if id == 1 {
		return Profile(5)
	}
	return null
}
func read = (out int?) {
	var p = find(1)
	return p?.score
}
`;
		const parsed = parse(`import System\n${input}`, core, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([]);
		const built = build(parsed.root, { arch: "c", audit: true });
		expect(built.errors ?? []).toEqual([]);
	});

	test("`?.` on a non-nullable target still suggests `.`", () => {
		const input = `import System

struct Profile {
	var int score
}

pub func main = () {
	var p = Profile(1)
	var x = p?.score ?? 0
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors.map((e) => e.message)).toEqual([
			"'?.' needs a nullable target — 'Profile' is not nullable; use '.'",
		]);
	});

	test("a nullable chain cannot be a `??` fallback (the nullness has no carrier there)", () => {
		const input = `import System

struct Profile {
	var int score
}

pub func main = () {
	var Profile? p = null
	var int? x = null
	var y = x ?? p?.score
}
`;
		const parsed = parse(input, core, undefined, { allow_internal: true });
		expect(parsed.errors.map((e) => e.message)).toEqual([
			"a nullable chain cannot be a '??' fallback — coalesce the chain first ('x ?? (b?.c ?? fb)')",
		]);
	});
});
