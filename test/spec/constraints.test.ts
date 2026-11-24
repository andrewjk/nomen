import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("spec: constraints - parameters", () => {
	test("literal satisfies constraint", () => {
		const input = `
func restricted = (int x: x > 5) {
    Console.write("\\{x}")
}
restricted(10)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("literal violates constraint is an error", () => {
		const input = `
func restricted = (int x: x > 5) {
    Console.write("\\{x}")
}
restricted(2)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("constraint referencing array length", () => {
		const input = `
func safe_index = (string[] source, int i: i >= 0 && i < source.length, out string) {
    return source.at(i)
}
const items = ["a", "b", "c"]
safe_index(items, 1)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("constraint referencing array length violation", () => {
		const input = `
func safe_index = (string[] source, int i: i >= 0 && i < source.length, out string) {
    return source.at(i)
}
const items = ["a", "b", "c"]
safe_index(items, 5)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("const passed to constrained param", () => {
		const input = `
func above_zero = (int x: x > 0) {}
const threshold = 10
above_zero(threshold)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("an unproven runtime argument cannot be verified", () => {
		const input = `
func above_zero = (int x: x > 0) {
    Console.write("\\{x}")
}

func run = (int n) {
    above_zero(n)
}

run(4)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("cannot be verified"))).toBe(true);
	});

	test("a guard proves the constraint", () => {
		const input = `
func above_zero = (int x: x > 0) {
    Console.write("\\{x}")
}

func run = (int n) {
    above_zero(n)        // Error: Parameter constraint cannot be verified

    if n > 0 {
        above_zero(n)    // OK — the guard proves it
    }
}

run(4)
`;
		const errors = compile_main(input);
		expect(errors.length).toBe(1);
	});
});

describe("spec: constraints - fields", () => {
	test("field constraints propagated to init", () => {
		const input = `
struct Bounded {
    var int x: x > 0
    var int y: y < 100
}
const b = Bounded(5, 50)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("field constraint violation is an error", () => {
		const input = `
struct Bounded {
    var int x: x > 0
    var int y: y < 100
}
const b2 = Bounded(-1, 50)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("default value checked at definition", () => {
		const input = `
struct Config {
    var int retries: retries >= 0 = 3
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("default value violating constraint is an error", () => {
		const input = `
struct Config {
    var int timeout: timeout > 0 = 0
}
`;
		const errors = compile_module(input);
		expect(errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});
});

describe("spec: constraints - flow facts", () => {
	test("an early-return zero guard proves != 0 for a user constraint", () => {
		const input = `
func divide = (int a, int b: b != 0, out int) => a / b

func f = (int a, int n, out int) {
    if n == 0 {
        return 0
    }
    return divide(a, n)
}

f(10, 2)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("an early-return zero guard discharges the divisor contract", () => {
		const input = `
func f = (int a, int n, out int) {
    if n == 0 {
        return 0
    }
    return a / n
}

f(10, 2)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("an early-return != guard pins the fall-through to zero", () => {
		const input = `
func need_zero = (int m: m == 0, out int) => m

func f = (int n, out int) {
    if n != 0 {
        return 99
    }
    return need_zero(n)
}

f(0)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("a non-exiting zero guard proves nothing", () => {
		const input = `
func f = (int a, int n, out int) {
    if n == 0 {
        Console.write("zero")
    }
    return a / n
}

f(10, 2)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("cannot be verified"))).toBe(true);
	});

	test("reassignment between guard and use drops the fact", () => {
		const input = `
func f = (int a, int n, out int) {
    var m = n
    if m == 0 {
        return 0
    }
    m = a
    return a / m
}

f(10, 2)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("cannot be verified"))).toBe(true);
	});

	test("a length snapshot carries its >= 0 fact through a guard", () => {
		const input = `
func last = (string[] a, string[] b, out string) {
    var n = a.length
    if n < b.length {
        return b.at(n)   // OK — n >= 0 (length fact), n < b.length (guard)
    }
    return ""
}

last(["a", "b"], ["c", "d", "e"])
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("compound && guards record every conjunct", () => {
		const input = `
func get = (string[] b, int i, out string) {
    if i >= 0 && i < b.length {
        return b.at(i)
    }
    return ""
}

get(["a"], 0)
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: constraints - variables", () => {
	test("variable constraint checked on init and reassign", () => {
		const input = `
func process = () {
    var int x: x > 5 = 10
    x = 20
}
process()
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("variable constraint violation on reassign is an error", () => {
		const input = `
func process = () {
    var int x: x > 5 = 10
    x = 2
}
process()
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});
});
