import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("List push", () => {
	test("push and read back via pop", async () => {
		const input = `
var List<int> list = List<int>()
list.push(10)
list.push(20)
list.push(30)
const int a = list.pop()
const int b = list.pop()
Console.write("\\{a} \\{b}")
`;
		await build_and_check_output(input, "list_push_pop", "30 20");
	});

	test("push multiple and pop all", async () => {
		const input = `
var List<int> list = List<int>()
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
		await build_and_check_output(input, "list_push_pop_all", "54321");
	});

	test("push triggers resize", async () => {
		const input = `
var List<int> list = List<int>()
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
		await build_and_check_output(input, "list_resize", "9");
	});

	test("push and pop interleaved", async () => {
		const input = `
var List<int> list = List<int>()
list.push(10)
const int a = list.pop()
list.push(20)
list.push(30)
const int b = list.pop()
Console.write("\\{a} \\{b}")
`;
		await build_and_check_output(input, "list_interleaved", "10 30");
	});
});

describe("List length", () => {
	test("length tracks pushes and pops", async () => {
		const input = `
var List<int> list = List<int>()
list.push(1)
list.push(2)
list.push(3)
Console.write("\\{list.length}")
const int x = list.pop()
Console.write("\\{list.length}")
`;
		await build_and_check_output(input, "list_length", "32");
	});
});
