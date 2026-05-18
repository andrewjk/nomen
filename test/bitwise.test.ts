import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("bitwise build", () => {
	test("bitwise AND", async () => {
		const input = `
const int a = 12
const int b = 10
const int c = a & b
Console.write("\\{c}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("bitwise_and", result, "8");
	});

	test("bitwise OR", async () => {
		const input = `
const int a = 12
const int b = 10
const int c = a | b
Console.write("\\{c}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("bitwise_or", result, "14");
	});

	test("bitwise XOR", async () => {
		const input = `
const int a = 12
const int b = 10
const int c = a ^ b
Console.write("\\{c}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("bitwise_xor", result, "6");
	});

	test("left shift", async () => {
		const input = `
const int a = 3
const int b = a << 2
Console.write("\\{b}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("bitwise_lsl", result, "12");
	});

	test("right shift", async () => {
		const input = `
const int a = 16
const int b = a >> 2
Console.write("\\{b}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("bitwise_asr", result, "4");
	});

	test("bitwise with comparison and AND", async () => {
		const input = `
const int a = 15
const int b = 6
const int c = a & b
Console.write("\\{c}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("bitwise_and_2", result, "6");
	});

	test("bitwise combined with arithmetic", async () => {
		const input = `
const int a = 5
const int b = 3
const int c = (a | b) + 1
Console.write("\\{c}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("bitwise_combined", result, "8");
	});
});
