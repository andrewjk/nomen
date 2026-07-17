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
const int threshold = 10
above_zero(threshold)
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: constraints - fields", () => {
	test("field constraints propagated to init", () => {
		const input = `
struct Bounded {
    var int x: x > 0
    var int y: x < 100
}
const b = Bounded(5, 50)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("field constraint violation is an error", () => {
		const input = `
struct Bounded {
    var int x: x > 0
    var int y: x < 100
}
const b = Bounded(-1, 50)
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
