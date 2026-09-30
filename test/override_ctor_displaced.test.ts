import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Residual displaced-copy corners of override-constructor returns: an
// overridden field whose CONSTRUCTOR-SEEDED value owns heap — a non-literal
// default expression (`var string a = "de" + "fault"` is evaluated fresh at
// construction and owned by the struct alone) — used to be displaced by the
// raw override store with no reclaim (LEAK: 1). The override sites now free
// the displaced seed ahead of the stores. The hoisted `_param_N`
// constructor-argument allocation attached to the anon literal's BASE is
// also surfaced now (collect_allocations walks the rewritten func_call's
// `.base`) — the return shape used to reference an undeclared temp.

describe("override-constructor displaced-copy reclamation", () => {
	test("return: non-literal default displaced by an override is reclaimed", async () => {
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
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`,
			"override_displaced_return",
			"a=override\nb=x\n",
			true,
		);
	});

	test("declaration: non-literal default displaced by an override is reclaimed", async () => {
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "de" + "fault"
	var string b
}

pub func main = (Init init) {
	var Pair p = [ .. Pair("x"), a = "override" ]
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`,
			"override_displaced_decl",
			"a=override\nb=x\n",
			true,
		);
	});

	test("literal default override emits no reclaim and stays balanced", async () => {
		await build_and_check_output(
			`
import System

struct Lit {
	var string a = "default"
	var string b
}

pub func main = (Init init) {
	var Lit l = [ .. Lit("x"), a = "override" ]
	Console.write("a=\\{l.a}\\n")
	Console.write("b=\\{l.b}\\n")
}
`,
			"override_displaced_literal",
			"a=override\nb=x\n",
			true,
		);
	});

	test("hoisted ctor-arg allocation through a return override compiles and runs", async () => {
		// `Pair(fresh())` hoists `const _param_0 = fresh()` onto the anon
		// literal's base; the return-override path used to emit the ctor call
		// without declaring the temp (C: use of undeclared identifier;
		// aarch64: undefined symbol at link).
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "default"
	var string b = "bee"

	func #init = (self, string s) {
		self.a = s
	}
}

func fresh = (out string) {
	return "fresh" + "!"
}

func make = (out Pair) {
	return [ .. Pair(fresh()), a = "override" ]
}

pub func main = (Init init) {
	var Pair p = make()
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`,
			"override_displaced_hoisted_arg",
			"a=override\nb=bee\n",
			true,
		);
	});
});
