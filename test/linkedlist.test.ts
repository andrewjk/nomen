import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("LinkedList<T> add and value", () => {
	test("add single element and read back", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
list.add(42)
if list.count > 0 {
  var int v = list.first()
  Console.write("\\{v}")
}
`;
		await build_and_check_output(input, "ll_add_single", "42");
	});

	test("add multiple elements preserves order", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
list.add(10)
list.add(20)
list.add(30)
for i of 0 .. list.count {
  var int v = list.at(i)
  if i > 0 {
    Console.write(" ")
  }
  Console.write("\\{v}")
}
`;
		await build_and_check_output(input, "ll_add_order", "10 20 30");
	});

	test("length tracks additions", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
var int l0 = list.length()
list.add(1)
var int l1 = list.length()
list.add(2)
list.add(3)
var int l3 = list.length()
Console.write("\\{l0} \\{l1} \\{l3}")
`;
		await build_and_check_output(input, "ll_length", "0 1 3");
	});

	test("empty list length is zero", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
Console.write("\\{list.length()}")
`;
		await build_and_check_output(input, "ll_empty_length", "0");
	});

	test("add negative values", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
list.add(-1)
list.add(-100)
list.add(0)
for i of 0 .. list.count {
  var int v = list.at(i)
  if i > 0 {
    Console.write(" ")
  }
  Console.write("\\{v}")
}
`;
		await build_and_check_output(input, "ll_negative", "-1 -100 0");
	});
});

describe("LinkedList<T> linking", () => {
	test("set_next and traverse linked list", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
var int a = list.count
list.add(10)
var int b = list.count
list.add(20)
var int c = list.count
list.add(30)
list.set_next(a, b)
list.set_next(b, c)
var int sum = 0
var int cur = list.head
while cur >= 0 && cur < list.count {
  sum = sum + list.at(cur)
  cur = list.next_at(cur)
}
Console.write("\\{sum}")
`;
		await build_and_check_output(input, "ll_traverse", "60");
	});

	test("next of last element is -1", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
list.add(1)
list.add(2)
var int n = list.next_at(1)
Console.write("\\{n}")
`;
		await build_and_check_output(input, "ll_next_end", "-1");
	});

	test("head is 0 after first add", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
list.add(99)
Console.write("\\{list.head}")
`;
		await build_and_check_output(input, "ll_head", "0");
	});

	test("head is -1 on empty list", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
Console.write("\\{list.head}")
`;
		await build_and_check_output(input, "ll_head_empty", "-1");
	});

	test("partial traversal with gaps", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
var int a = list.count
list.add(1)
var int b = list.count
list.add(2)
var int c = list.count
list.add(3)
list.set_next(a, c)
var int sum = 0
var int cur = a
while cur >= 0 && cur < list.count {
  sum = sum + list.at(cur)
  cur = list.next_at(cur)
}
Console.write("\\{sum}")
`;
		await build_and_check_output(input, "ll_skip", "4");
	});
});

describe("LinkedList<T> index before add pattern", () => {
	test("count before add gives correct index", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
var int idx0 = list.count
list.add(100)
var int idx1 = list.count
list.add(200)
for i of 0 .. list.count {
  var int v = list.at(i)
  if i > 0 {
    Console.write(" ")
  }
  Console.write("\\{v}")
}
`;
		await build_and_check_output(input, "ll_index_pattern", "100 200");
	});
});
