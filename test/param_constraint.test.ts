import path from "node:path";

import { describe, test, expect } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

describe("param constraint", () => {
	test("simple literal index violates constraint", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func restricted = (int i: i > 0) {
    Console.write("ok")
}
func caller = () {
    restricted(0)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("simple literal index satisfies constraint", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func restricted = (int i: i > 0) {
    Console.write("ok")
}
func caller = () {
    restricted(5)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("array length constraint violation", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func restricted = (string[] source, int i: i < source.length) {
    Console.write("ok")
}
func caller = () {
    restricted(["a", "b", "c"], 4)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("array length constraint satisfied", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func restricted = (string[] source, int i: i < source.length) {
    Console.write("ok")
}
func caller = () {
    restricted(["a", "b", "c"], 2)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("compound constraint violated", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func restricted = (string[] source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    restricted(["a", "b", "c"], 5)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("compound constraint satisfied", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func restricted = (string[] source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    restricted(["a", "b", "c"], 2)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("compound constraint with variable array violated", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func restricted = (string[] source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    var things = ["a", "b", "c"]
    restricted(things, 4)
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("for-loop variable satisfies compound constraint", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func restricted = (string[] source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    var things = ["a", "b", "c"]
    for i of 0 .. things.length {
        restricted(things, i)
    }
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("for-loop variable modified before constraint check fails", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func restricted = (string[] source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    var things = ["a", "b", "c"]
    for i of 0 .. things.length {
        i += 1
        restricted(things, i)
    }
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("cannot be verified"))).toBe(true);
	});

	test("for-loop variable with non-literal range fails constraint", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func restricted = (string[] source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    var things = ["a", "b", "c"]
    var start = 0
    for i of start .. things.length {
        restricted(things, i)
    }
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("cannot be verified"))).toBe(true);
	});

	test("for-loop variable satisfies lower bound only", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func check = (int i: i >= 0) {
    Console.write("ok")
}
func caller = () {
    for i of 0 .. 10 {
        check(i)
    }
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("for-loop variable satisfies upper bound only", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func check = (int i: i < 10) {
    Console.write("ok")
}
func caller = () {
    for i of 0 .. 10 {
        check(i)
    }
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("for-loop variable range does not satisfy lower bound", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func check = (int i: i >= 5) {
    Console.write("ok")
}
func caller = () {
    for i of 0 .. 3 {
        check(i)
    }
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("for-loop variable range does not satisfy upper bound", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func check = (int i: i < 3) {
    Console.write("ok")
}
func caller = () {
    for i of 0 .. 5 {
        check(i)
    }
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("for-loop variable satisfies i <= constraint", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func check = (int i: i <= 9) {
    Console.write("ok")
}
func caller = () {
    for i of 0 .. 10 {
        check(i)
    }
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("while loop variable fails constraint (no range info)", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func restricted = (string[] source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    var things = ["a", "b", "c"]
    var k = 0
    while k < things.length; k += 1 {
        restricted(things, k)
    }
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("cannot be verified"))).toBe(true);
	});

	test("constraint comparing int with string errors", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func bad = (int i: i > "abc") {
    Console.write("ok")
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("Type mismatch"))).toBe(true);
	});

	test("constraint that is just an int literal errors", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func bad = (int i: 5) {
    Console.write("ok")
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.some((e) => e.message.includes("boolean expression"))).toBe(true);
	});

	test("constraint that is arithmetic expression errors", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func bad = (int i: i + 1) {
    Console.write("ok")
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.some((e) => e.message.includes("boolean expression"))).toBe(true);
	});

	test("constraint that is a string literal errors", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func bad = (int i: "hello") {
    Console.write("ok")
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.some((e) => e.message.includes("boolean expression"))).toBe(true);
	});

	test("valid bool constraint with && passes", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
func ok = (int i: i >= 0 && i < 10) {
    Console.write("ok")
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors).toEqual([]);
	});

	test("local var constraint with wrong type errors", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
pub func main = () {
    var int x: x > "abc" = 5
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.some((e) => e.message.includes("Type mismatch"))).toBe(true);
	});

	test("local var constraint that is not boolean errors", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const input = `
import System
pub func main = () {
    var int x: x + 1 = 5
}
`;
		const parsed = parse(input, lib);
		expect(parsed.errors.some((e) => e.message.includes("boolean expression"))).toBe(true);
	});
});
