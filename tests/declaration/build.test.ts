import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Declaration build");

test("const with value", () => {
	const input = `
const x = 5
`;
	const parsed = parse(input);
	const result = build(parsed.root);
	const expected = `
long x = 5;
`;
	expect(parsed.errors).toEqual([]);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("const with type", () => {
	const input = `
const x: int
`;
	const parsed = parse(input);
	const result = build(parsed.root);
	const expected = `
long x;
`;
	expect(parsed.errors).toEqual([]);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("var with value", () => {
	const input = `
var x = 5
`;
	const parsed = parse(input);
	const result = build(parsed.root);
	const expected = `
long x = 5;
`;
	expect(parsed.errors).toEqual([]);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("var with type", () => {
	const input = `
var x: int
`;
	const parsed = parse(input);
	const result = build(parsed.root);
	const expected = `
long x;
`;
	expect(parsed.errors).toEqual([]);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
