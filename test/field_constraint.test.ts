import path from "node:path";

import { describe, test, expect } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

describe("field constraints", () => {
	test("constructor with violating argument errors", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
struct Foo {
    var int x: x > 5
}
func caller = () {
    var Foo f = Foo(2)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("constructor with satisfying argument passes", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
struct Foo {
    var int x: x > 5
}
func caller = () {
    var Foo f = Foo(10)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("default value satisfying constraint passes", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
struct Foo {
    var int x: x > 5 = 12
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("default value violating constraint errors", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
struct Foo {
    var int x: x > 5 = 2
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("field assignment violating constraint errors", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
struct Foo {
    var int x: x > 5
}
func caller = () {
    var Foo f = Foo(10)
    f.x = 2
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("field assignment satisfying constraint passes", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
struct Foo {
    var int x: x > 5
}
func caller = () {
    var Foo f = Foo(10)
    f.x = 20
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});
});
