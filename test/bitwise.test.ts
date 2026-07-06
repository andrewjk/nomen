import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("bitwise build", () => {
	test("bitwise AND", async () => {
		const input = `
const int a = 12
const int b = 10
const int c = a & b
Console.write("\\{c}")
`;
		await build_and_check_output(input, "bitwise_and", "8");
	});

	test("bitwise OR", async () => {
		const input = `
const int a = 12
const int b = 10
const int c = a | b
Console.write("\\{c}")
`;
		await build_and_check_output(input, "bitwise_or", "14");
	});

	test("bitwise XOR", async () => {
		const input = `
const int a = 12
const int b = 10
const int c = a ^ b
Console.write("\\{c}")
`;
		await build_and_check_output(input, "bitwise_xor", "6");
	});

	test("left shift", async () => {
		const input = `
const int a = 3
const int b = a << 2
Console.write("\\{b}")
`;
		await build_and_check_output(input, "bitwise_lsl", "12");
	});

	test("right shift", async () => {
		const input = `
const int a = 16
const int b = a >> 2
Console.write("\\{b}")
`;
		await build_and_check_output(input, "bitwise_asr", "4");
	});

	test("bitwise with comparison and AND", async () => {
		const input = `
const int a = 15
const int b = 6
const int c = a & b
Console.write("\\{c}")
`;
		await build_and_check_output(input, "bitwise_and_2", "6");
	});

	test("bitwise combined with arithmetic", async () => {
		const input = `
const int a = 5
const int b = 3
const int c = (a | b) + 1
Console.write("\\{c}")
`;
		await build_and_check_output(input, "bitwise_combined", "8");
	});
});
