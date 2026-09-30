import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Non-literal struct field DEFAULTS (`var string a = "de" + "fault"`,
// `var int n = answer()`) are evaluated fresh by the constructor on both
// backends. The aarch64 backend used to skip them entirely (the field kept
// stack garbage — SEGFAULT on first read); the ctor now evaluates the
// expression into the field slot. A heap-owning default (a string op, a
// heap-returning call) is recorded at the ctor-binding site so scope exit
// frees it and displaced stores (overrides, reassignments) reclaim it; a
// literal-returning call leaves rodata in the field and is never recorded
// (never freed).

describe("non-literal struct field defaults", () => {
	test("auto-ctor evaluates the default; reassignment re-evaluates and reclaims", async () => {
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "de" + "fault"
	var string b
}

pub func main = (Init init) {
	var Pair p = Pair("x")
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
	p = Pair("y")
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`,
			"nonliteral_default_hold",
			"a=default\nb=x\na=default\nb=y\n",
			true,
		);
	});

	test("custom #init ctor evaluates the default before the body runs", async () => {
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "de" + "fault"
	var string b

	func #init = (self, string s) {
		self.b = s
	}
}

pub func main = (Init init) {
	var Pair p = Pair("x")
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`,
			"nonliteral_default_custom_init",
			"a=default\nb=x\n",
			true,
		);
	});

	test("override displacing the evaluated default reclaims it (return + decl)", async () => {
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "de" + "fault"
	var string b
}

func make = (out Pair) {
	return [ .. Pair("x"), a = "override" ]
}

pub func main = (Init init) {
	var Pair p = make()
	var Pair q = [ .. Pair("x"), a = "o2" ]
	Console.write("p=\\{p.a}\\{p.b}\\n")
	Console.write("q=\\{q.a}\\{q.b}\\n")
}
`,
			"nonliteral_default_override",
			"p=overridex\nq=o2x\n",
			true,
		);
	});

	test("override displacing the evaluated default reclaims it (reassignment)", async () => {
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "de" + "fault"
	var string b
}

pub func main = (Init init) {
	var Pair p = Pair("x")
	p = [ .. Pair("y"), a = "after" ]
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`,
			"nonliteral_default_override_reassign",
			"a=after\nb=y\n",
			true,
		);
	});

	test("class-typed struct evaluates the default; destroy owns it", async () => {
		await build_and_check_output(
			`
import System

class Box {
	var string tag = "de" + "fault"
}

pub func main = (Init init) {
	var Box b = Box()
	Console.write("tag=\\{b.tag}\\n")
}
`,
			"nonliteral_default_class",
			"tag=default\n",
			true,
		);
	});

	test("non-string default expression is evaluated by the auto-ctor", async () => {
		await build_and_check_output(
			`
import System

func answer = (out int) {
	return 42
}

struct Config {
	var int n = answer()
	var int m = 7
}

pub func main = (Init init) {
	var Config c = Config()
	Console.write("n=\\{c.n}\\n")
	Console.write("m=\\{c.m}\\n")
}
`,
			"nonliteral_default_scalar",
			"n=42\nm=7\n",
			true,
		);
	});

	test("literal-returning default stays rodata; heap-returning default is owned", async () => {
		await build_and_check_output(
			`
import System

func ro = (out string) {
	return "static"
}

func fresh = (out string) {
	return "fr" + "esh"
}

struct Lit {
	var string s = ro()
}

struct Owned {
	var string s = fresh()
}

pub func main = (Init init) {
	var Lit l = Lit()
	var Owned o = Owned()
	Console.write("l=\\{l.s}\\n")
	Console.write("o=\\{o.s}\\n")
}
`,
			"nonliteral_default_ownership",
			"l=static\no=fresh\n",
			true,
		);
	});
});
