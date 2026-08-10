import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("Map set and get", () => {
	test("set and get single value", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(1, 100)
const int v = m.get(1)
Console.write("\\{v}")
`;
		await build_and_check_output(input, "map_set_single", "100");
	});

	test("get missing key returns 0", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(1, 100)
const int v = m.get(99)
Console.write("\\{v}")
`;
		await build_and_check_output(input, "map_get_missing", "0");
	});

	test("get on empty map returns 0", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
const int v = m.get(1)
Console.write("\\{v}")
`;
		await build_and_check_output(input, "map_get_empty", "0");
	});

	test("set multiple key-value pairs", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(1, 10)
m.set(2, 20)
m.set(3, 30)
const int a = m.get(1)
const int b = m.get(2)
const int c = m.get(3)
Console.write("\\{a} \\{b} \\{c} \\{m.length}")
`;
		await build_and_check_output(input, "map_set_multi", "10 20 30 3");
	});

	test("set same key updates value", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(1, 10)
m.set(1, 99)
const int v = m.get(1)
Console.write("\\{v} \\{m.length}")
`;
		await build_and_check_output(input, "map_set_update", "99 1");
	});
});

describe("Map has", () => {
	test("has returns true for existing key", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(1, 10)
Console.write("\\{m.has(1)}")
`;
		await build_and_check_output(input, "map_has_existing", "true");
	});

	test("has returns false for missing key", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(1, 10)
Console.write("\\{m.has(99)}")
`;
		await build_and_check_output(input, "map_has_missing", "false");
	});
});

describe("Map hash collisions and resize", () => {
	test("keys with same hash (linear probing)", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(8, 100)
m.set(16, 200)
m.set(24, 300)
const int a = m.get(8)
const int b = m.get(16)
const int c = m.get(24)
Console.write("\\{a} \\{b} \\{c}")
`;
		await build_and_check_output(input, "map_collisions", "100 200 300");
	});

	test("many entries triggers rehash", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(1, 100)
m.set(2, 200)
m.set(3, 300)
m.set(4, 400)
m.set(5, 500)
m.set(6, 600)
m.set(7, 700)
m.set(8, 800)
m.set(9, 900)
m.set(10, 1000)
m.set(11, 1100)
m.set(12, 1200)
const int total = m.get(1) + m.get(2) + m.get(3) + m.get(4) + m.get(5) + m.get(6) + m.get(7) + m.get(8) + m.get(9) + m.get(10) + m.get(11) + m.get(12)
Console.write("\\{total} \\{m.length}")
`;
		await build_and_check_output(input, "map_rehash", "7800 12");
	});

	test("negative keys", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(-1, 10)
m.set(-100, 20)
const int a = m.get(-1)
const int b = m.get(-100)
Console.write("\\{a} \\{b}")
`;
		await build_and_check_output(input, "map_negative_keys", "10 20");
	});

	test("no false matches after rehash", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(10, 1)
m.set(20, 2)
m.set(30, 3)
m.set(40, 4)
m.set(50, 5)
m.set(60, 6)
m.set(70, 7)
m.set(80, 8)
m.set(90, 9)
m.set(100, 10)
const int v15 = m.get(15)
const int v25 = m.get(25)
const int v99 = m.get(99)
Console.write("\\{v15} \\{v25} \\{v99}")
`;
		await build_and_check_output(input, "map_no_false", "0 0 0");
	});
});

describe("Map remove", () => {
	test("remove key from map", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(1, 10)
m.set(2, 20)
m.set(3, 30)
m.remove(2)
const bool a = m.has(1)
const bool b = m.has(2)
const bool c = m.has(3)
Console.write("\\{a} \\{b} \\{c} \\{m.length}")
`;
		await build_and_check_output(input, "map_remove", "true false true 2");
	});

	test("remove non-existent key is no-op", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(1, 10)
m.remove(99)
Console.write("\\{m.has(1)} \\{m.length}")
`;
		await build_and_check_output(input, "map_remove_missing", "true 1");
	});

	test("remove then re-add works", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(1, 10)
m.set(2, 20)
m.remove(1)
m.set(1, 99)
const int v = m.get(1)
Console.write("\\{v} \\{m.length}")
`;
		await build_and_check_output(input, "map_remove_readd", "99 2");
	});

	test("remove shifts a displaced entry past an unmoved neighbor", async () => {
		// cap 8: key 2 -> slot 2, key 3 -> slot 3, key 10 (home 2) collides and
		// lands at slot 4. Removing key 2 opens a gap at slot 2; key 3 is at its
		// home so it must stay, but the gap has to advance past it and pull key 10
		// forward into slot 2. If remove stops at the first non-moveable entry,
		// key 10 gets stranded behind the empty slot and becomes unfindable.
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(2, 100)
m.set(3, 200)
m.set(10, 300)
m.remove(2)
const int v3 = m.get(3)
const int v10 = m.get(10)
const bool h2 = m.has(2)
Console.write("\\{v3} \\{v10} \\{h2} \\{m.length}")
`;
		await build_and_check_output(input, "map_remove_shift_past", "200 300 false 2");
	});
});

describe("Map with string keys", () => {
	test("set and get with string keys", async () => {
		const input = `
var Map<string, int> m = Map<string, int>()
m.set("hello", 1)
m.set("world", 2)
const int a = m.get("hello")
const int b = m.get("world")
const int c = m.get("missing")
Console.write("\\{a} \\{b} \\{c} \\{m.length}")
`;
		await build_and_check_output(input, "map_string_keys", "1 2 0 2");
	});

	test("has with string keys", async () => {
		const input = `
var Map<string, int> m = Map<string, int>()
m.set("alpha", 10)
m.set("beta", 20)
Console.write("\\{m.has("alpha")} \\{m.has("beta")} \\{m.has("gamma")}")
`;
		await build_and_check_output(input, "map_string_has", "true true false");
	});

	test("update existing string key", async () => {
		const input = `
var Map<string, int> m = Map<string, int>()
m.set("key", 100)
m.set("key", 200)
const int v = m.get("key")
Console.write("\\{v} \\{m.length}")
`;
		await build_and_check_output(input, "map_string_update", "200 1");
	});

	test("many string keys triggers rehash", async () => {
		const input = `
var Map<string, int> m = Map<string, int>()
m.set("one", 1)
m.set("two", 2)
m.set("three", 3)
m.set("four", 4)
m.set("five", 5)
m.set("six", 6)
m.set("seven", 7)
m.set("eight", 8)
m.set("nine", 9)
m.set("ten", 10)
m.set("eleven", 11)
m.set("twelve", 12)
const int total = m.get("one") + m.get("two") + m.get("three") + m.get("four") + m.get("five") + m.get("six") + m.get("seven") + m.get("eight") + m.get("nine") + m.get("ten") + m.get("eleven") + m.get("twelve")
Console.write("\\{total} \\{m.length}")
`;
		await build_and_check_output(input, "map_string_rehash", "78 12");
	});

	test("remove string key", async () => {
		const input = `
var Map<string, int> m = Map<string, int>()
m.set("a", 1)
m.set("b", 2)
m.set("c", 3)
m.remove("b")
Console.write("\\{m.has("a")} \\{m.has("b")} \\{m.has("c")} \\{m.length}")
`;
		await build_and_check_output(input, "map_string_remove", "true false true 2");
	});

	test("variadic-tuple constructor with string keys", async () => {
		const input = `
var Map<string, int> m = Map<string, int>(["x", 10], ["y", 20])
const int a = m.get("x")
const int b = m.get("y")
Console.write("\\{a} \\{b} \\{m.length}")
`;
		await build_and_check_output(input, "map_string_init", "10 20 2");
	});
});

describe("Map with string values", () => {
	test("set and get string values", async () => {
		const input = `
var Map<int, string> m = Map<int, string>()
m.set(1, "one")
m.set(2, "two")
const string a = m.get(1)
const string b = m.get(2)
Console.write("\\{a} \\{b}")
`;
		await build_and_check_output(input, "map_string_values", "one two");
	});
});
