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

// Custom `#init` COMPUTED seeds (`self.a = s + "!"`): the seed owns heap but
// is not a field DEFAULT, so the displaced-copy helpers (which read DEFAULT
// expressions only) never saw it — an override displaced it un-freed, a plain
// binding leaked it at scope exit, and the write itself orphaned a heap
// default. The seed analysis now scans the #init bodies
// (init_computed_heap_string_fields): qualifying fields are recorded at the
// ctor-binding sites, treated as displaced at the override sites, and the
// write reclaims a displaced heap default (first write only).
describe("#init computed-seed ownership", () => {
	const SEED_STRUCT = `
import System

struct Pair {
	var string a = "default"
	var string b = "bee"

	func #init = (self, string s) {
		self.a = s + "!"
	}
}
`;

	test("plain ctor binding frees the computed seed at scope exit", async () => {
		await build_and_check_output(
			`${SEED_STRUCT}
pub func main = (Init init) {
	var Pair p = Pair("x")
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`,
			"init_seed_plain_binding",
			"a=x!\nb=bee\n",
			true,
		);
	});

	test("declaration override reclaims the displaced computed seed", async () => {
		await build_and_check_output(
			`${SEED_STRUCT}
pub func main = (Init init) {
	var Pair p = [ .. Pair("x"), a = "override" ]
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`,
			"init_seed_decl_override",
			"a=override\nb=bee\n",
			true,
		);
	});

	test("return override reclaims the displaced computed seed", async () => {
		await build_and_check_output(
			`${SEED_STRUCT}
func make = (out Pair) {
	return [ .. Pair("x"), a = "override" ]
}

pub func main = (Init init) {
	var Pair p = make()
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`,
			"init_seed_return_override",
			"a=override\nb=bee\n",
			true,
		);
	});

	test("assignment override reclaims the old seed and the displaced new seed", async () => {
		await build_and_check_output(
			`${SEED_STRUCT}
pub func main = (Init init) {
	var Pair p = Pair("y")
	p = [ .. Pair("x"), a = "override" ]
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`,
			"init_seed_assign_override",
			"a=override\nb=bee\n",
			true,
		);
	});

	test("the #init write reclaims a displaced heap default", async () => {
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "de" + "fault"
	var string b = "bee"

	func #init = (self, string s) {
		self.a = s + "!"
	}
}

pub func main = (Init init) {
	var Pair p = Pair("x")
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`,
			"init_seed_heap_default",
			"a=x!\nb=bee\n",
			true,
		);
	});

	test("a no-default field computed by #init is freed at scope exit", async () => {
		// No-default fields cannot be overridden (the checker requires them to
		// be set by Pair(...)), so only the binding-site record matters.
		await build_and_check_output(
			`
import System

struct Pair {
	var string a
	var string b = "bee"

	func #init = (self, string s) {
		self.a = s + "!"
	}
}

pub func main = (Init init) {
	var Pair p = Pair("x")
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`,
			"init_seed_nodefault",
			"a=x!\nb=bee\n",
			true,
		);
	});

	test("param-alias seed stays un-analyzed across an override", async () => {
		// `self.a = s` borrows the caller's argument temp — recording or
		// freeing it would double-free (Pair(fresh()) hoists a fresh
		// _param_0 the return-override shape references).
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
			"init_seed_param_alias",
			"a=override\nb=bee\n",
			true,
		);
	});

	test("conditional seed over a heap default stays balanced on both paths", async () => {
		// Every path leaves the field holding heap (computed seed / heap
		// default), so the record is sound; the write-path free of the
		// displaced default rides the branch.
		await build_and_check_output(
			`
import System

struct Pair {
	var string a = "de" + "fault"
	var string b = "bee"

	func #init = (self, string s, bool hot) {
		if hot {
			self.a = s + "!"
		}
	}
}

pub func main = (Init init) {
	var Pair hot_p = Pair("x", true)
	var Pair cold_p = Pair("y", false)
	Console.write("a=\\{hot_p.a}\\n")
	Console.write("a=\\{cold_p.a}\\n")
}
`,
			"init_seed_conditional_heap_default",
			"a=x!\na=default\n",
			true,
		);
	});
});
