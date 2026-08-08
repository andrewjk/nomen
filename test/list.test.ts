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

describe("List of value structs", () => {
	// Regression: List<T> used the 8-byte Buffer `_int` primitives, so a
	// multi-field value struct read back as garbage / crashed. It now uses the
	// size-aware `_T` primitives (memcpy-based), backed by the monomorphizer
	// retyping `self`/param/body value nodes and the C backend emitting the
	// element struct's typedef to the header for by-value returns.
	const PT = `struct Pt {
  var int x
  var int y
}`;

	test("push and read back via at", async () => {
		const input = `
${PT}
var List<Pt> pts = List<Pt>()
var Pt a = Pt(1, 2)
pts.push(a)
var Pt b = Pt(3, 4)
pts.push(b)
for i of 0 .. pts.length {
  var Pt p = pts.at(i)
  Console.write("\\{p.x},\\{p.y} ")
}
`;
		await build_and_check_output(input, "list_struct_push_at", "1,2 3,4 ");
	});

	test("set replaces an element", async () => {
		const input = `
${PT}
var List<Pt> pts = List<Pt>()
var Pt a = Pt(1, 1)
pts.push(a)
var Pt b = Pt(2, 2)
pts.push(b)
var Pt c = Pt(3, 3)
pts.push(c)
var Pt d = Pt(9, 9)
var int i = 1
if i >= 0 && i < pts.length {
  pts.set(i, d)
}
for i of 0 .. pts.length {
  var Pt p = pts.at(i)
  Console.write("\\{p.x},\\{p.y} ")
}
`;
		await build_and_check_output(input, "list_struct_set", "1,1 9,9 3,3 ");
	});

	test("pop returns and removes the last element", async () => {
		const input = `
${PT}
var List<Pt> pts = List<Pt>()
var Pt a = Pt(1, 1)
pts.push(a)
var Pt b = Pt(2, 2)
pts.push(b)
var Pt p = pts.pop()
Console.write("\\{p.x},\\{p.y} \\{pts.length}")
`;
		await build_and_check_output(input, "list_struct_pop", "2,2 1");
	});
});
