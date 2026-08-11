import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("Set add and has", () => {
	test("add single value and check has", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(42)
const bool has_it = s.has(42)
Console.write("\\{has_it}")
`;
		await build_and_check_output(input, "set_add_single", "true");
	});

	test("has returns false for missing value", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(1)
const bool has_it = s.has(99)
Console.write("\\{has_it}")
`;
		await build_and_check_output(input, "set_has_missing", "false");
	});

	test("has on empty set returns false", async () => {
		const input = `
var Set<int> s = Set<int>()
const bool has_it = s.has(1)
Console.write("\\{has_it}")
`;
		await build_and_check_output(input, "set_has_empty", "false");
	});

	test("add duplicate does not increase length", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(5)
s.add(5)
s.add(5)
Console.write("\\{s.length}")
`;
		await build_and_check_output(input, "set_add_dup", "1");
	});

	test("add multiple distinct values", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(1)
s.add(2)
s.add(3)
const bool a = s.has(1)
const bool b = s.has(2)
const bool c = s.has(3)
const bool d = s.has(4)
Console.write("\\{a} \\{b} \\{c} \\{d} \\{s.length}")
`;
		await build_and_check_output(input, "set_add_multi", "true true true false 3");
	});
});

describe("Set hash collisions and resize", () => {
	test("values with same hash (linear probing)", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(8)
s.add(16)
s.add(24)
const bool a = s.has(8)
const bool b = s.has(16)
const bool c = s.has(24)
Console.write("\\{a} \\{b} \\{c} \\{s.length}")
`;
		await build_and_check_output(input, "set_collisions", "true true true 3");
	});

	test("add many values triggers rehash", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(1)
s.add(2)
s.add(3)
s.add(4)
s.add(5)
s.add(6)
s.add(7)
s.add(8)
s.add(9)
s.add(10)
s.add(11)
s.add(12)
const bool has_all = s.has(1) && s.has(2) && s.has(3) && s.has(4) && s.has(5) && s.has(6) && s.has(7) && s.has(8) && s.has(9) && s.has(10) && s.has(11) && s.has(12)
Console.write("\\{has_all} \\{s.length}")
`;
		await build_and_check_output(input, "set_rehash", "true 12");
	});

	test("negative values", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(-1)
s.add(-100)
s.add(-50)
const bool a = s.has(-1)
const bool b = s.has(-100)
const bool c = s.has(-50)
const bool d = s.has(1)
Console.write("\\{a} \\{b} \\{c} \\{d}")
`;
		await build_and_check_output(input, "set_negative", "true true true false");
	});

	test("no false positives after rehash", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(10)
s.add(20)
s.add(30)
s.add(40)
s.add(50)
s.add(60)
s.add(70)
s.add(80)
s.add(90)
s.add(100)
const bool has_15 = s.has(15)
const bool has_25 = s.has(25)
const bool has_35 = s.has(35)
const bool has_99 = s.has(99)
Console.write("\\{has_15} \\{has_25} \\{has_35} \\{has_99}")
`;
		await build_and_check_output(input, "set_no_false_pos", "false false false false");
	});
});

describe("Set remove", () => {
	test("remove value from set", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(1)
s.add(2)
s.add(3)
s.remove(2)
const bool a = s.has(1)
const bool b = s.has(2)
const bool c = s.has(3)
Console.write("\\{a} \\{b} \\{c} \\{s.length}")
`;
		await build_and_check_output(input, "set_remove", "true false true 2");
	});

	test("remove non-existent value is no-op", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(1)
s.remove(99)
Console.write("\\{s.has(1)} \\{s.length}")
`;
		await build_and_check_output(input, "set_remove_missing", "true 1");
	});

	test("remove then re-add works", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(1)
s.add(2)
s.remove(1)
s.add(1)
Console.write("\\{s.has(1)} \\{s.has(2)} \\{s.length}")
`;
		await build_and_check_output(input, "set_remove_readd", "true true 2");
	});
});

describe("Set<string> (Hashable + Equatable element)", () => {
	test("add and has with string elements", async () => {
		const input = `
var Set<string> s = Set<string>()
s.add("alpha")
s.add("beta")
s.add("gamma")
Console.write("\\{s.has("alpha")} \\{s.has("beta")} \\{s.has("delta")} \\{s.length}")
`;
		await build_and_check_output(input, "set_string_has", "true true false 3");
	});

	test("add duplicate string does not increase length", async () => {
		const input = `
var Set<string> s = Set<string>()
s.add("x")
s.add("x")
Console.write("\\{s.length}")
`;
		await build_and_check_output(input, "set_string_dup", "1");
	});

	test("many string elements triggers rehash", async () => {
		const input = `
var Set<string> s = Set<string>()
s.add("one")
s.add("two")
s.add("three")
s.add("four")
s.add("five")
s.add("six")
s.add("seven")
s.add("eight")
s.add("nine")
s.add("ten")
s.add("eleven")
s.add("twelve")
const bool has_all = s.has("one") && s.has("two") && s.has("three") && s.has("four") && s.has("five") && s.has("six") && s.has("seven") && s.has("eight") && s.has("nine") && s.has("ten") && s.has("eleven") && s.has("twelve")
Console.write("\\{has_all} \\{s.length}")
`;
		await build_and_check_output(input, "set_string_rehash", "true 12");
	});

	test("remove string element", async () => {
		const input = `
var Set<string> s = Set<string>()
s.add("a")
s.add("b")
s.add("c")
s.remove("b")
Console.write("\\{s.has("a")} \\{s.has("b")} \\{s.has("c")} \\{s.length}")
`;
		await build_and_check_output(input, "set_string_remove", "true false true 2");
	});
});
