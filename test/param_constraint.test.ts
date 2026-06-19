import path from "node:path";

import { describe, test, expect } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

function make_lib() {
	return get_library(path.resolve(import.meta.dirname, "../core"));
}

describe("param constraint", () => {
	test("restricted function with constraint violation errors", () => {
		const lib = make_lib();
		const input = `
import System
func restricted = (int x: x > 5) {
    Console.write("\\{x}")
}
func caller = () {
    restricted(2)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("restricted function with valid call passes", () => {
		const lib = make_lib();
		const input = `
import System
func restricted = (int x: x > 5) {
    Console.write("\\{x}")
}
func caller = () {
    restricted(6)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("restricted function with const arg that satisfies", () => {
		const lib = make_lib();
		const input = `
import System
func restricted = (int x: x > 5) {
    Console.write("\\{x}")
}
func caller = () {
    const int val = 10
    restricted(val)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("restricted function with const arg that violates", () => {
		const lib = make_lib();
		const input = `
import System
func restricted = (int x: x > 5) {
    Console.write("\\{x}")
}
func caller = () {
    const int val = 1
    restricted(val)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});
});
