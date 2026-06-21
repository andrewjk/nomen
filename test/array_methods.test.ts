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
    var int[3] arr = [10, 20, 30]
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
    var int[3] arr = [10, 20, 30]
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
    var int[3] arr = [10, 20, 30]
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
    var int[3] arr = [10, 20, 30]
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
    var int[3] arr = [10, 20, 30]
    var int x = arr.at_end()
    Console.write("\\{x}")
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("with_length() truncates array", () => {
		const input = `
import System
pub func main = () {
    var int[5] arr = [1, 2, 3, 4, 5]
    var int[3] shorter = arr.with_length(3)
    Console.write("\\{shorter.length}")
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("with_length() constraint fails for negative length", () => {
		const input = `
import System
pub func main = () {
    var int[3] arr = [10, 20, 30]
    var int[1] bad = arr.with_length(-1)
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
    var string[2] arr = ["hello", "world"]
    var string s = arr.at(0)
    Console.write(s)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});
});
