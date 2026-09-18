import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Bounds-check elimination extensions from the PERF.md findings: bounds from
// earlier `&&` operands apply while checking later operands of the same
// condition (Gap 1); parallel-length param contracts (Gap 2); field-
// referencing out-contracts flowing to field uses (Gap 3); out-contract
// bounds transferred onto the variables a call result is bound to (Gap 4).

function expect_clean(source: string) {
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
}

function expect_verify_error(source: string) {
	const parsed = parse_with_imports(source);
	expect(parsed.errors.some((e) => e.message.includes("cannot be verified"))).toBe(true);
}

describe("condition-position bounds (gap 1)", () => {
	test("at() in a while && condition sees earlier operands' bounds", () => {
		expect_clean(`
func common = (List<int> xs, List<int> ys, out int) {
	var int i = 0
	while i < xs.length && i < ys.length && xs.at(i) == ys.at(i) {
		i += 1
	}
	return i
}
`);
	});

	test("at() in an if && condition sees earlier operands' bounds", () => {
		expect_clean(`
func prev_eq = (List<int> xs, int i, out bool) {
	if i > 0 && i < xs.length && xs.at(i - 1) == xs.at(i) {
		return true
	}
	return false
}
`);
	});

	test("at() after || operands sees the negated bounds", () => {
		expect_clean(`
func probe = (List<int> xs, int i, out int) {
	if i < 0 || i >= xs.length || xs.at(i) == 7 {
		return 0
	}
	return xs.at(i)
}
`);
	});

	test("bounds flow left-to-right only: at() before its guard still errors", () => {
		// The right operand's bounds must NOT apply to the left operand —
		// short-circuit evaluates left first, when nothing is known about i.
		expect_verify_error(`
func bad = (List<int> xs, int i, out int) {
	while xs.at(i) == 0 && i < xs.length {
		i += 1
	}
	return i
}
`);
	});

	test("common prefix loop computes correctly", async () => {
		const input = `
func common = (List<int> xs, List<int> ys, out int) {
	var int i = 0
	while i < xs.length && i < ys.length && xs.at(i) == ys.at(i) {
		i += 1
	}
	return i
}
var List<int> a = List<int>()
a.push(1)
a.push(2)
a.push(3)
var List<int> b = List<int>()
b.push(1)
b.push(2)
b.push(9)
Console.write("\\{common(a, b)}\\n")
`;
		await build_and_check_output(input, "bounds_cond_common", "2\n");
	});
});

describe("parallel-length contracts (gap 2)", () => {
	test("a.length == b.length param contract unlocks both containers", () => {
		expect_clean(`
func sum_par = (List<int> xs, List<int> hash: hash.length == xs.length, out int) {
	var int i = 0
	var int n = 0
	while i < xs.length {
		n += hash.at(i)
		i += 1
	}
	return n
}
`);
	});

	test("contract clause position does not matter", () => {
		expect_clean(`
func sum_par = (List<int> xs, List<int> hash, int hi: hash.length == xs.length && hi >= 0 && hi <= xs.length, out int) {
	var int i = 0
	while i < hi {
		const int h = hash.at(i)
		i += 1
	}
	return i
}
`);
	});

	test("without the equality clause the access still errors", () => {
		expect_verify_error(`
func sum_par = (List<int> xs, List<int> hash, out int) {
	var int i = 0
	while i < xs.length {
		const int h = hash.at(i)
		i += 1
	}
	return i
}
`);
	});

	test("parallel-length sum computes correctly", async () => {
		const input = `
func sum_par = (List<int> xs, List<int> hash: hash.length == xs.length, out int) {
	var int i = 0
	var int n = 0
	while i < xs.length {
		n += hash.at(i)
		i += 1
	}
	return n
}
var List<int> a = List<int>()
a.push(1)
a.push(2)
var List<int> h = List<int>()
h.push(10)
h.push(20)
Console.write("\\{sum_par(a, h)}\\n")
`;
		await build_and_check_output(input, "bounds_parallel_length", "30\n");
	});
});

describe("field-referencing out-contracts (gap 3)", () => {
	test("out.a bounds flow to p.a uses through a class", () => {
		expect_clean(`
pub class Pair {
	var int a = 0
}
func find = (List<int> xs, out Pair: out.a >= 0 && out.a < xs.length) {
	var Pair p = Pair()
	p.a = xs.length / 2
	return p
}
func use = (List<int> xs, out int) {
	const Pair p = find(xs)
	return xs.at(p.a)
}
`);
	});

	test("bounds on one field do not leak to another field", () => {
		expect_verify_error(`
pub class Pair2 {
	var int a = 0
	var int b = 0
}
func find = (List<int> xs, out Pair2: out.a >= 0 && out.a < xs.length) {
	var Pair2 p = Pair2()
	p.a = xs.length / 2
	return p
}
func use = (List<int> xs, out int) {
	const Pair2 p = find(xs)
	return xs.at(p.b)
}
`);
	});
});

describe("out-contract bounds on bound variables (gap 4)", () => {
	test("const binding carries the contract", () => {
		expect_clean(`
func mid = (List<int> xs, out int: out >= 0 && out <= xs.length) {
	return xs.length / 2
}
func use = (List<int> xs, out int) {
	const int m = mid(xs)
	return xs.at(m)
}
`);
	});

	test("var binding carries the contract", () => {
		expect_clean(`
func mid = (List<int> xs, out int: out >= 0 && out <= xs.length) {
	return xs.length / 2
}
func use = (List<int> xs, out int) {
	var int m = mid(xs)
	return xs.at(m)
}
`);
	});

	test("assignment (not declaration) carries the contract", () => {
		expect_clean(`
func mid = (List<int> xs, out int: out >= 0 && out <= xs.length) {
	return xs.length / 2
}
func use = (List<int> xs, out int) {
	var int m = 0
	m = mid(xs)
	return xs.at(m)
}
`);
	});

	test("reassigning the variable drops the contract bounds", () => {
		expect_verify_error(`
func mid = (List<int> xs, out int: out >= 0 && out <= xs.length) {
	return xs.length / 2
}
func use = (List<int> xs, out int) {
	var int m = mid(xs)
	m = m + xs.length
	return xs.at(m)
}
`);
	});

	test("mid helper computes correctly through a binding", async () => {
		const input = `
func mid = (List<int> xs, out int: out >= 0 && out <= xs.length) {
	return xs.length / 2
}
func use = (List<int> xs, out int) {
	const int m = mid(xs)
	return xs.at(m)
}
var List<int> a = List<int>()
a.push(4)
a.push(5)
a.push(6)
a.push(7)
Console.write("\\{use(a)}\\n")
`;
		await build_and_check_output(input, "bounds_bound_var", "6\n");
	});
});
