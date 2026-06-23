import path from "node:path";

import { describe, test, expect } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

const lib = get_library(path.resolve(import.meta.dirname, "../core"));

describe("Array methods", () => {
	test("at() returns element at valid index", () => {
		const input = `
import System
pub func main = () {
    var arr = Array(10, 20, 30)
    var int x = arr.at(0)
    var int y = arr.at(1)
    var int z = arr.at(2)
    Console.write("\\{x} \\{y} \\{z}")
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("at() constraint fails for out-of-bounds index", () => {
		const input = `
import System
pub func main = () {
    var arr = Array(10, 20, 30)
    var int x = arr.at(5)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("at() constraint fails for negative index", () => {
		const input = `
import System
pub func main = () {
    var arr = Array(10, 20, 30)
    var int x = arr.at(-1)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("at() with for-loop variable passes constraint", () => {
		const input = `
import System
pub func main = () {
    var arr = Array(10, 20, 30)
    for i of 0 .. arr.length {
        var int x = arr.at(i)
        Console.write("\\{x}")
    }
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("at_end() returns last element", () => {
		const input = `
import System
pub func main = () {
    var arr = Array(10, 20, 30)
    var int x = arr.at_end()
    Console.write("\\{x}")
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("with() creates array with repeated value", () => {
		const input = `
import System
pub func main = () {
    var arr = Array.with(0, 5)
    Console.write("\\{arr.length}")
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("with() constraint fails for negative count", () => {
		const input = `
import System
pub func main = () {
    var bad = Array.with(0, -1)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("at() works with string arrays", () => {
		const input = `
import System
pub func main = () {
    var arr = Array("hello", "world")
    var s = arr.at(0)
    Console.write(s)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});
});
