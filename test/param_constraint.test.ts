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
});
