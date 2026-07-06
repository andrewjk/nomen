import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

// PARSE
describe("tuple parse", () => {
	test("parse tuple type declaration", () => {
		const input = `
var [int, string] things
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("parse tuple value inference", () => {
		const input = `
var things = [1, "first"]
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("parse tuple with three elements", () => {
		const input = `
var [int, string, bool] triple = [42, "hello", true]
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("parse tuple destructuring", () => {
		const input = `
func get_person = (int id, out [string, int]) {
	return ["Andrew", 42]
}
var [name, age] = get_person(1)
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("parse variadic tuple parameter", () => {
		const input = `
func sum_pairs = (...[int, int] pairs, out int) {
	return 0
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});
});

// TYPE CHECK
describe("tuple type checking", () => {
	test("reject mismatched tuple element type", () => {
		const input = `
var [int, string] things = [42, 99]
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBe(1);
		expect(parsed.errors[0].message).toBe("Type mismatch in tuple: int (expected string)");
	});

	test("reject wrong tuple arity (too few)", () => {
		const input = `
var [int, string, bool] things = [42, "hi"]
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("reject wrong tuple arity (too many)", () => {
		const input = `
var [int, string] things = [42, "hi", true]
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("homogeneous array still works as array (not tuple)", () => {
		const input = `
var Array<int> nums = [1, 2, 3]
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("tuple type as function return type", () => {
		const input = `
func make_pair = (int a, int b, out [int, int]) {
	return [a, b]
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});
});

// BUILD & RUN
describe("tuple build and run", () => {
	test("declare tuple and access fields", async () => {
		const input = `
var [int, string] things = [42, "answer"]
Console.write("\\{things._0} \\{things._1}")
`;
		await build_and_check_output(input, "tuple_decl_access", "42 answer");
	});

	test("infer tuple type from heterogeneous value", async () => {
		const input = `
var things = [1, "first"]
Console.write("\\{things._0} \\{things._1}")
`;
		await build_and_check_output(input, "tuple_infer_access", "1 first");
	});

	test("tuple with three different types", async () => {
		const input = `
var triple = [42, "hello", true]
Console.write("\\{triple._0} \\{triple._1} \\{triple._2}")
`;
		await build_and_check_output(input, "tuple_triple", "42 hello true");
	});

	test("tuple returned from function", async () => {
		const input = `
func make_pair = (int a, int b, out [int, int]) {
	return [a, b]
}
const p = make_pair(10, 20)
Console.write("\\{p._0} \\{p._1}")
`;
		await build_and_check_output(input, "tuple_returned", "10 20");
	});

	test("tuple reassignment", async () => {
		const input = `
var [int, string] things = [1, "old"]
things = [2, "new"]
Console.write("\\{things._0} \\{things._1}")
`;
		await build_and_check_output(input, "tuple_reassign", "2 new");
	});
});

// DESTRUCTURING
describe("tuple destructuring", () => {
	test("destructure tuple from function call", async () => {
		const input = `
func get_person = (int id, out [string, int]) {
	return ["Andrew", id + 100]
}
var [name, id] = get_person(12)
Console.write("\\{name} \\{id}")
`;
		await build_and_check_output(input, "tuple_destructure_call", "Andrew 112");
	});

	test("destructure three-element tuple", async () => {
		const input = `
func get_record = (int id, out [int, string, bool]) {
	return [id, "rec", true]
}
var [num, label, active] = get_record(7)
Console.write("\\{num} \\{label} \\{active}")
`;
		await build_and_check_output(input, "tuple_destructure_three", "7 rec true");
	});

	test("destructure tuple literal directly", async () => {
		const input = `
var [a, b] = [11, "hello"]
Console.write("\\{a} \\{b}")
`;
		await build_and_check_output(input, "tuple_destructure_literal", "11 hello");
	});
});

// VARIADIC TUPLES
describe("variadic tuples", () => {
	test("variadic tuple parameter sum", async () => {
		const input = `
func sum_pairs = (...[int, int] pairs, out int) {
	var total = 0
	var i = 0
	while i < pairs.length {
		total = total + pairs.at(i)._0 + pairs.at(i)._1
		i = i + 1
	}
	return total
}
const result = sum_pairs([1, 2], [3, 4])
Console.write("\\{result}")
`;
		await build_and_check_output(input, "vtuple_sum", "10");
	});

	test("variadic tuple with mixed types", async () => {
		const input = `
func first_parts = (...[string, int] pairs, out string) {
	var result = ">"
	var i = 0
	while i < pairs.length {
		result = result + pairs.at(i)._0
		i = i + 1
	}
	return result
}
const out = first_parts(["count", 1], ["sum", 2])
Console.write("\\{out}")
`;
		await build_and_check_output(input, "vtuple_mixed", ">countsum");
	});

	test("variadic tuple with zero args", async () => {
		const input = `
func count_pairs = (...[int, int] pairs, out int) {
	return pairs.length
}
const n = count_pairs()
Console.write("\\{n}")
`;
		await build_and_check_output(input, "vtuple_zero", "0");
	});

	test("variadic tuple mixed with fixed param", async () => {
		const input = `
func sum_with_base = (int base, ...[int, int] pairs, out int) {
	var total = base
	var i = 0
	while i < pairs.length {
		total = total + pairs.at(i)._0 + pairs.at(i)._1
		i = i + 1
	}
	return total
}
const result = sum_with_base(100, [1, 2], [3, 4])
Console.write("\\{result}")
`;
		await build_and_check_output(input, "vtuple_with_base", "110");
	});
});

// COMPOSITION
describe("tuple composition", () => {
	test("nested tuple access", async () => {
		const input = `
func swap = ([int, int] pair, out [int, int]) {
	return [pair._1, pair._0]
}
const p = swap([1, 2])
Console.write("\\{p._0} \\{p._1}")
`;
		await build_and_check_output(input, "tuple_swap", "2 1");
	});

	test("tuple as struct field", async () => {
		const input = `
struct Container {
	var [int, string] payload
}
const c = Container([99, "bottles"])
Console.write("\\{c.payload._0} \\{c.payload._1}")
`;
		await build_and_check_output(input, "tuple_as_field", "99 bottles");
	});
});
