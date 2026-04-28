import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Range build");

test("exclusive", () => {
	const input = `
var x = 1..4
`;
	const parsed = parse(input);
	const result = build(parsed.root);
	const expected = `
long x[] = {1, 2, 3};
`;
	expect(parsed.errors).toEqual([]);
	expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("inclusive", () => {
	const input = `
var x = 1.=4
`;
	const parsed = parse(input);
	const result = build(parsed.root);
	const expected = `
long x[] = {1, 2, 3, 4};
`;
	expect(parsed.errors).toEqual([]);
	expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
