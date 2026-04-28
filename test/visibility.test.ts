import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import test_error from "./test_error";

describe("visibility errors", () => {
	test("invalid target", () => {
		const input = `
pub if true {
  // ...
}
`;
		const expected = [
			test_error(input, "Visibility can only be set for const, var, struct, trait or func", 2, 1),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("accessing priv fields", () => {
		const input = `
struct Person {
  priv var string name
  priv func greet = () -> {}
}
var Person x
x.name = "Andrew"
x.greet()
`;
		const expected = [
			test_error(input, "Can't access priv field: name", 7, 3),
			test_error(input, "Can't access priv function: greet", 8, 3),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("priv fields in trait", () => {
		const input = `
trait Person {
  priv var string name
  priv func greet = () -> {}
}
`;
		const expected = [
			test_error(input, "Trait fields cannot be priv", 3, 3),
			test_error(input, "Trait functions cannot be priv", 4, 3),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
