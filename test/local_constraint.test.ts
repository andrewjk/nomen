import { describe, test, expect } from "vite-plus/test";

import parse from "../src/parse";

describe("local var constraints", () => {
	test("declaration with satisfying default passes", () => {
		const input = `
func test = () {
    var int x: x > 5 = 10
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("declaration with violating default errors", () => {
		const input = `
func test = () {
    var int x: x > 5 = 2
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});

	test("reassignment violating constraint errors", () => {
		const input = `
func test = () {
    var int x: x > 5 = 10
    x = 2
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});
});
