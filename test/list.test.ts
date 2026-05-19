import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("List push", () => {
	test("push and read back via pop", async () => {
		const input = `
var List list = List()
list.push(10)
list.push(20)
list.push(30)
const int a = list.pop()
const int b = list.pop()
Console.write("\\{a} \\{b}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("list_push_pop", result, "30 20");
	});

	test("push multiple and pop all", async () => {
		const input = `
var List list = List()
list.push(1)
list.push(2)
list.push(3)
list.push(4)
list.push(5)
const int a = list.pop()
const int b = list.pop()
const int c = list.pop()
const int d = list.pop()
const int e = list.pop()
Console.write("\\{a}\\{b}\\{c}\\{d}\\{e}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("list_push_pop_all", result, "54321");
	});

	test("push triggers resize", async () => {
		const input = `
var List list = List()
list.push(1)
list.push(2)
list.push(3)
list.push(4)
list.push(5)
list.push(6)
list.push(7)
list.push(8)
list.push(9)
Console.write("\\{list.length}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("list_resize", result, "9");
	});

	test("push and pop interleaved", async () => {
		const input = `
var List list = List()
list.push(10)
const int a = list.pop()
list.push(20)
list.push(30)
const int b = list.pop()
Console.write("\\{a} \\{b}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("list_interleaved", result, "10 30");
	});
});

describe("List length", () => {
	test("length tracks pushes and pops", async () => {
		const input = `
var List list = List()
list.push(1)
list.push(2)
list.push(3)
Console.write("\\{list.length}")
const int x = list.pop()
Console.write("\\{list.length}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("list_length", result, "32");
	});
});
