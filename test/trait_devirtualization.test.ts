import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { collect_rebound_names } from "../src/check/utils/devirtualize";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

// Devirtualization of trait calls (PERF_PLAN item 11): a trait-typed local
// whose binding provably holds ONE known conformer (a direct constructor
// initializer, never rebound anywhere in the function) lowers its method
// calls as direct `<Class>_<method>` calls — no `_get_trait_func` on C, no
// vtable loads + `blr` on aarch64. Every shape that could change the
// conformer (assignment, swap, a `ref` argument pass — including inside a
// loop body or a branch, where statement-order tracking would be unsound)
// keeps the vtable dispatch.

const PRELUDE = `
import System
trait Speaker {
	func speak = (self, out string)
}

mv struct Dog: Speaker {
	var string name
	func speak = (self, out string) {
		return "woof"
	}
}

mv struct Cat: Speaker {
	func speak = (self, out string) {
		return "meow"
	}
}
`;

function build_code(input: string, arch: "c" | "aarch64"): string {
	const parsed = parse_raw(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch });
	expect(result.errors ?? []).toEqual([]);
	return result.code ?? "";
}

function trait_call_counts(
	code: string,
	arch: "c" | "aarch64",
): { direct: number; virtual: number } {
	if (arch === "c") {
		return {
			// The resolver DEFINITION is always emitted; only call sites count.
			virtual: code.match(/\)_get_trait_func\(/g)?.length ?? 0,
			direct: code.match(/= (Dog|Cat)_speak\(/g)?.length ?? 0,
		};
	}
	return {
		virtual: code.match(/blr x10/g)?.length ?? 0,
		direct: code.match(/bl (Dog|Cat)_speak\n/g)?.length ?? 0,
	};
}

describe("devirtualization: lowering shape", () => {
	const cases: Record<string, string> = {
		known_conformer: `
pub func main = (Init init) {
	var Speaker s = Dog("Rex")
	Console.write(s.speak())
}`,
		known_value_struct_conformer: `
trait Rule {
	func test = (self, string line, out bool)
}
struct HeadingV: Rule {
	pub func test = (self, string line, out bool) {
		return line.at_or(0, ' ') == '#'
	}
}
pub func main = (Init init) {
	var Rule r = HeadingV()
	if r.test("# h") {
		Console.write("heading")
	} else {
		Console.write("other")
	}
}`,
		mv_propagates_concrete: `
pub func main = (Init init) {
	var Speaker s = Dog("Rex")
	var Speaker t = mv s
	Console.write(t.speak())
}`,
		reassigned_across_conformers: `
pub func main = (Init init) {
	var Speaker s = Dog("Rex")
	s = Cat()
	Console.write(s.speak())
}`,
		reassigned_in_loop_body: `
pub func main = (Init init) {
	var Speaker s = Dog("Rex")
	var int i = 0
	while i < 3 {
		Console.write(s.speak())
		s = Cat()
		i += 1
	}
}`,
		reassigned_in_if_branch: `
pub func main = (Init init) {
	var Speaker s = Dog("Rex")
	if init.argc > 99 {
		s = Cat()
	}
	Console.write(s.speak())
}`,
		passed_as_ref_argument: `
func retype = (ref Speaker sp) {
	sp = Cat()
}
pub func main = (Init init) {
	var Speaker s = Dog("Rex")
	retype(ref s)
	Console.write(s.speak())
}`,
		trait_default_only: `
trait Greeter {
	func greet = (self, out string) {
		return "hello"
	}
}
struct Shy: Greeter {
}
pub func main = (Init init) {
	var Greeter g = Shy()
	Console.write(g.greet())
}`,
	};

	test("known conformer lowers to a direct call on both backends", () => {
		for (const arch of ["c", "aarch64"] as const) {
			const counts = trait_call_counts(build_code(PRELUDE + cases.known_conformer, arch), arch);
			expect(counts.direct).toBe(1);
			expect(counts.virtual).toBe(0);
		}
	});

	test("boxed value-struct conformer lowers to a direct call", () => {
		for (const arch of ["c", "aarch64"] as const) {
			const code = build_code(PRELUDE + cases.known_value_struct_conformer, arch);
			if (arch === "c") {
				expect(code).toContain("HeadingV_test(");
				expect(code.match(/\)_get_trait_func\(/g)?.length ?? 0).toBe(0);
			} else {
				expect(code).toContain("bl HeadingV_test\n");
				expect(code.match(/blr x10/g)?.length ?? 0).toBe(0);
			}
		}
	});

	test("mv propagation keeps the concrete known", () => {
		for (const arch of ["c", "aarch64"] as const) {
			const counts = trait_call_counts(
				build_code(PRELUDE + cases.mv_propagates_concrete, arch),
				arch,
			);
			expect(counts.direct).toBe(1);
			expect(counts.virtual).toBe(0);
		}
	});

	test("reassignment across conformers keeps the vtable dispatch", () => {
		for (const arch of ["c", "aarch64"] as const) {
			const counts = trait_call_counts(
				build_code(PRELUDE + cases.reassigned_across_conformers, arch),
				arch,
			);
			expect(counts.direct).toBe(0);
			expect(counts.virtual).toBe(1);
		}
	});

	test("a rebinding inside a loop body keeps the dispatch (back-edge retypes earlier sites)", () => {
		for (const arch of ["c", "aarch64"] as const) {
			const counts = trait_call_counts(
				build_code(PRELUDE + cases.reassigned_in_loop_body, arch),
				arch,
			);
			expect(counts.direct).toBe(0);
			expect(counts.virtual).toBe(1);
		}
	});

	test("a rebinding inside a branch keeps the dispatch", () => {
		for (const arch of ["c", "aarch64"] as const) {
			const counts = trait_call_counts(
				build_code(PRELUDE + cases.reassigned_in_if_branch, arch),
				arch,
			);
			expect(counts.direct).toBe(0);
			expect(counts.virtual).toBe(1);
		}
	});

	test("a ref-argument pass (callee may rebind the slot) keeps the dispatch", () => {
		for (const arch of ["c", "aarch64"] as const) {
			const counts = trait_call_counts(
				build_code(PRELUDE + cases.passed_as_ref_argument, arch),
				arch,
			);
			expect(counts.direct).toBe(0);
			expect(counts.virtual).toBe(1);
		}
	});

	test("a trait-default-only method keeps the dispatch", () => {
		for (const arch of ["c", "aarch64"] as const) {
			const code = build_code(PRELUDE + cases.trait_default_only, arch);
			// The concrete struct defines no `greet`, so the direct symbol the
			// stamp would name does not exist — the stamp must not fire.
			if (arch === "c") {
				expect(code).toContain("_get_trait_func(");
				expect(code).not.toContain("Shy_greet(");
			} else {
				expect(code).toContain("blr x10");
				expect(code).not.toContain("bl Shy_greet\n");
			}
		}
	});
});

describe("devirtualization: runtime", () => {
	test("devirtualized call computes the same result", async () => {
		await build_and_check_output(
			`
trait Speaker {
	func speak = (self, out string)
}
mv struct Dog: Speaker {
	var string name
	func speak = (self, out string) {
		return "woof"
	}
}
var Speaker s = Dog("Rex")
var Speaker d = Dog("Fido")
Console.write("\\{s.speak()} \\{d.speak()}")`,
			"devirt_known_runtime",
			"woof woof",
		);
	});

	test("devirtualized boxed value-struct conformer computes the same result", async () => {
		await build_and_check_output(
			`
trait Rule {
	func test = (self, string line, out bool)
}
struct HeadingV: Rule {
	pub func test = (self, string line, out bool) {
		return line.at_or(0, ' ') == '#'
	}
}
var Rule r = HeadingV()
if r.test("# h") {
	Console.write("heading")
} else {
	Console.write("other")
}`,
			"devirt_value_struct_runtime",
			"heading",
		);
	});

	test("polymorphic sites (reassigned, ref-rebound) still dispatch correctly", async () => {
		await build_and_check_output(
			`
trait Speaker {
	func speak = (self, out string)
}
mv struct Dog: Speaker {
	var string name
	func speak = (self, out string) {
		return "woof"
	}
}
mv struct Cat: Speaker {
	func speak = (self, out string) {
		return "meow"
	}
}
var Speaker s = Dog("Rex")
s = Cat()
Console.write(s.speak())
var Speaker t = Dog("Fido")
Console.write(t.speak())`,
			"devirt_polymorphic_runtime",
			"meowwoof",
		);
	});

	test("loop-body rebinding retypes later iterations correctly", async () => {
		await build_and_check_output(
			`
trait Speaker {
	func speak = (self, out string)
}
mv struct Dog: Speaker {
	var string name
	func speak = (self, out string) {
		return "woof"
	}
}
mv struct Cat: Speaker {
	func speak = (self, out string) {
		return "meow"
	}
}
var Speaker s = Dog("Rex")
var int i = 0
while i < 3 {
	Console.write(s.speak())
	s = Cat()
	i += 1
}`,
			"devirt_loop_rebind_runtime",
			"woofmeowmeow",
		);
	});
});

describe("devirtualization: rebind scan", () => {
	function rebound(src: string): Set<string> {
		const parsed = parse(src, system, undefined, { allow_user_raw: true });
		expect(parsed.errors).toEqual([]);
		for (const stmt of parsed.root.statements) {
			if (stmt.node_type === "func" && (stmt as { name?: string }).name === "f") {
				return collect_rebound_names((stmt as { statements: unknown[] }).statements as never);
			}
		}
		return new Set();
	}

	test("assignment targets, swap operands, and ref args are collected", () => {
		const names = rebound(`
mv struct P {
	var int v = 0
}
func take = (mv P p) {
	return
}
func g = (ref int x) {
	return
}
func f = (int n) {
	var P a = P()
	var P b = P()
	var int c = 3
	a = P()
	take(mv a swap b)
	g(ref c)
}`);
		expect(names.has("a")).toBe(true); // assignment target + swap donor
		expect(names.has("b")).toBe(true); // swap replacement
		expect(names.has("c")).toBe(true); // ref arg
	});

	test("reads and declarations alone collect nothing", () => {
		const names = rebound(`
func f = (int n) {
	var int a = n + 1
	f(a)
}`);
		expect(names.size).toBe(0);
	});
});
