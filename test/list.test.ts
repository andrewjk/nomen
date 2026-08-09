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

describe("List<string>", () => {
	// Regression: a `List<string>` compiled but crashed at runtime on the
	// aarch64 backend (SIGABRT) and on cleanup. The monomorphized
	// `List<string>.at`/`.slice` bodies call `self.items.load_T(i)`, and
	// because the monomorphized body's `self.items` access node carries no
	// type, `value_is_owned_string` could not resolve `load_T` and fell back
	// to the conservative "owned heap string" classification. That marked
	// `.at`/`.slice` as heap-returning, so every call site freed the returned
	// `char*` — a borrow of the buffer's slot (or a static literal address) —
	// crashing on the free. The fix treats `.at`/`.first`/`.slice`/`load_T`
	// (without `owned_return`) as borrows in `value_is_owned_string`, mirroring
	// the C backend's `is_string_borrow`. `pop` (mov out T) stays owned.

	test("push and read back via at", async () => {
		const input = `
var List<string> xs = List<string>()
xs.push("hello")
xs.push("world")
for i of 0 .. xs.length {
  Console.write(xs.at(i))
}
`;
		await build_and_check_output(input, "list_string_push_at", "helloworld");
	});

	test("set replaces an element", async () => {
		const input = `
var List<string> xs = List<string>()
xs.push("a")
xs.push("b")
var int i = 0
if i >= 0 && i < xs.length {
  xs.set(i, "X")
}
for i of 0 .. xs.length {
  Console.write(xs.at(i))
}
`;
		await build_and_check_output(input, "list_string_set", "Xb");
	});

	test("at result used in a comparison (borrow not freed)", async () => {
		// Two `.at` calls inside one `==` must each survive until the
		// comparison runs — neither is an owned temporary to free. Uses
		// loop-bounded indices so the access constraint discharges.
		const input = `
var List<string> xs = List<string>()
xs.push("x")
xs.push("x")
var bool same = false
for i of 0 .. xs.length {
  for j of 0 .. xs.length {
    if xs.at(i) == xs.at(j) {
      same = true
    }
  }
}
Console.write("\\{same}")
`;
		await build_and_check_output(input, "list_string_at_compare", "true");
	});
});
