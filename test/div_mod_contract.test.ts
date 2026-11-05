import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// DIVISOR CONTRACT (SPEC, Operator Functions): integer `/` and `%` behave as
// if declared with a constrained divisor — `(self, int other: other != 0,
// out int)` — the compile-time contract machinery `.at` applies to indices.
// A PROVABLY zero divisor (a literal, a const, a value the flow facts
// contradict) is rejected outright; an unverifiable divisor errors outside
// core library methods, discharged by guards (`if n != 0`, `if n > 0`,
// clamps) or by provable values. Floats stay unconstrained (IEEE division
// by zero is defined). Constraints on user operator functions
// (`#op_mod … : other != 0`) verify at the operation site — provably
// violating arguments error.

/** A complete program whose main_body body must `return` the output int. */
const PROG = (body: string) => `
import System

func main_body = (out int) {
	${body}
}

pub func main = (Init init) {
	Console.write("\\{main_body()}")
}
`;

describe("divisor contract: compile-time", () => {
	test("literal zero division", () => {
		const parsed = parse_raw(PROG("var int x = 5 / 0\n\treturn x"));
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Parameter constraint not satisfied: divisor");
	});

	test("literal zero modulo", () => {
		const parsed = parse_raw(PROG("var int x = 5 % 0\n\treturn x"));
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Parameter constraint not satisfied: divisor");
	});

	test("const zero divisor", () => {
		const parsed = parse_raw(PROG("const int d = 0\n\tvar int x = 5 / d\n\treturn x"));
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Parameter constraint not satisfied: divisor");
		expect(parsed.errors[0].message).toContain("divisor != 0");
	});

	test("unverifiable runtime divisor is rejected outside the core library", () => {
		const parsed = parse_raw(
			PROG("func half = (int n, out int) { return 10 / n }\n\treturn half(5)"),
		);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Parameter constraint cannot be verified");
	});

	test("float division by zero is unconstrained (IEEE)", () => {
		const parsed = parse_raw(PROG("var float f = 1.5\n\tvar float g = f / 0.0\n\treturn 0"));
		expect(parsed.errors).toEqual([]);
	});
});

describe("divisor contract: discharge", () => {
	test("a non-zero literal divides — runtime correct on both backends", async () => {
		await build_and_check_output(
			PROG("var int q = 10 / 2\n\treturn q"),
			"divmod_lit_div",
			"5",
			true,
		);
		await build_and_check_output(
			PROG("var int r = 17 % 5\n\treturn r"),
			"divmod_lit_mod",
			"2",
			true,
		);
	});

	test("a non-zero const divides", async () => {
		await build_and_check_output(
			PROG("const int d = 4\n\tvar int q = 20 / d\n\treturn q"),
			"divmod_const_div",
			"5",
			true,
		);
	});

	test("an initializer-known divisor discharges (var n = 2)", async () => {
		await build_and_check_output(
			PROG("var int n = 2\n\tvar int q = 10 / n\n\treturn q"),
			"divmod_init_div",
			"5",
			true,
		);
	});

	test("an `if n != 0` guard discharges — runtime correct", async () => {
		await build_and_check_output(
			PROG(`var int n = 2
	var int q = 0
	if n != 0 { q = 10 / n }
	return q`),
			"divmod_guard_neq",
			"5",
			true,
		);
	});

	test("an `if n > 0` guard discharges", () => {
		const parsed = parse_raw(PROG("var int n = 2\n\tif n > 0 { var int q = 10 / n }\n\treturn 0"));
		expect(parsed.errors).toEqual([]);
	});

	test("a clamp (`if n < 1 { n = 1 }`) discharges — runtime correct", async () => {
		await build_and_check_output(
			PROG(`var int n = 0
	if n < 1 { n = 1 }
	return 10 / n`),
			"divmod_clamp_div",
			"10",
			true,
		);
	});

	test("compound %= with a guarded divisor — runtime correct", async () => {
		await build_and_check_output(
			PROG(`var int total = 17
	var int m = 100
	if m != 0 { total %= m }
	return total`),
			"divmod_compound_mod",
			"17",
			true,
		);
	});

	test("a contract-carrying helper: guard inside, division discharged", async () => {
		const input = `
import System

func half = (int n, out int) {
	if n != 0 {
		return 10 / n
	}
	return 0
}

func main_body = (out int) {
	return half(5)
}

pub func main = (Init init) {
	Console.write("\\{main_body()}")
}
`;
		await build_and_check_output(input, "divmod_guard_fn", "2", true);
	});
});

describe("user operator contracts (#op_div / #op_mod with constraints)", () => {
	/** A Ratio whose #op_div declares its divisor contract. */
	const ratio_program = (divisor: string) => `
import System

struct Ratio {
	var int value

	pub func #op_div = (self, int scale: scale != 0, out Ratio) {
		return Ratio(self.value / scale)
	}
}

func main_body = (out int) {
	var r = Ratio(100)
	var x = r / ${divisor}
	return x.value
}

pub func main = (Init init) {
	Console.write("\\{main_body()}")
}
`;

	test("a provably violating argument errors at the operation site", () => {
		const parsed = parse_raw(ratio_program("0"));
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Parameter constraint not satisfied: scale");
	});

	test("a non-zero literal argument compiles and runs — both backends", async () => {
		await build_and_check_output(ratio_program("4"), "divmod_user_op_ok", "25", true);
	});

	test("the declared constraint discharges the operator body's own division", () => {
		// `scaled` divides by a runtime parameter; the declared `by != 0`
		// constraint applies bounds onto the parameter, which is what makes
		// the body's `/` verify. The call site passes a provably non-zero
		// argument so both halves of the contract hold.
		const input = `
import System

struct Vec {
	var int x
	var int y

	pub func scaled = (self, int by: by != 0, out Vec) {
		return Vec(self.x / by, self.y / by)
	}
}

func main_body = (out int) {
	var Vec v = Vec(20, 60)
	var Vec s = v.scaled(2)
	return s.x + s.y / 2
}

pub func main = (Init init) {
	Console.write("\\{main_body()}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.errors ?? []).toEqual([]);
	});
});
