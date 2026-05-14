import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("switch build", () => {
	test("switch statement", async () => {
		const input = `
var x = 10
switch {
	case x > 5 {
		Console.write("it's big")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_statement", result, "it's big");
	});

	test("switch statement with lots of branches", async () => {
		const input = `
var x = 10
switch {
	case x > 9 {
		Console.write("it's big")
	}
	case x > 5 {
		Console.write("it's medium")
	}
	case x > 0 {
		Console.write("it's small")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_statement_with_branches", result, "it's big");
	});

	test("switch statement with else", async () => {
		const input = `
const x = 10
switch {
	case x > 20 {
		Console.write("it's big")
	}
	else {
		Console.write("it's small")
	}
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_statement_with_else", result, "it's small");
	});

	test("switch expression", async () => {
		const input = `
var x = 10
const y = switch {
	case x > 9 -> "it's big"
	case x > 5 -> "it's medium"
	case x > 0 -> "it's small"
}
Console.write(y)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });

		expect(parsed.errors).toEqual([]);
		await check_output("switch_expression", result, "it's big");
	});
});

// ERRORS
describe("switch errors", () => {
	test("string condition", () => {
		const input = `
switch {
	case "hi" {
		// ...
	}
}
`;
		const expected = [test_error(input, "Switch case condition must be a bool, not string", 2, 4)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
