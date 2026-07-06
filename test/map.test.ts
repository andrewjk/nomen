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
});
