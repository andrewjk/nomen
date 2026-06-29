import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ll_add_single", result, "42");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ll_add_order", result, "10 20 30");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ll_length", result, "0 1 3");
	});

	test("empty list length is zero", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
Console.write("\\{list.length()}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ll_empty_length", result, "0");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ll_negative", result, "-1 -100 0");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ll_traverse", result, "60");
	});

	test("next of last element is -1", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
list.add(1)
list.add(2)
var int n = list.next_at(1)
Console.write("\\{n}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ll_next_end", result, "-1");
	});

	test("head is 0 after first add", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
list.add(99)
Console.write("\\{list.head}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ll_head", result, "0");
	});

	test("head is -1 on empty list", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
Console.write("\\{list.head}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ll_head_empty", result, "-1");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ll_skip", result, "4");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ll_index_pattern", result, "100 200");
	});
});
