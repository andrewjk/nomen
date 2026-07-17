import { describe, expect, test } from "vite-plus/test";

import { compile_main } from "./_helpers.ts";

describe("spec: tuples", () => {
	test("tuple type declaration", () => {
		const input = `
var [int, string] things
var [int, string, bool] triple
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("tuple values", () => {
		const input = `
var things = [1, "first"]
var triple = [42, "hello", true]
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("typed array vs tuple", () => {
		const input = `
var Array<int> nums = [1, 2, 3]
var mixed = [1, "hello"]
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("tuple field access", () => {
		const input = `
var [int, string] things = [42, "answer"]
Console.write("\\{things._0} \\{things._1}")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("destructuring from function return", () => {
		const input = `
func get_person = (int id, out [string, int]) {
    return ["Andrew", id + 100]
}
var [name, age] = get_person(12)
Console.write("\\{name} \\{age}")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("destructuring from tuple literal", () => {
		const input = `
var [a, b] = [11, "hello"]
Console.write("\\{a} \\{b}")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("tuple return types", () => {
		const input = `
func make_pair = (int a, int b, out [int, int]) {
    return [a, b]
}
const p = make_pair(10, 20)
Console.write("\\{p._0} \\{p._1}")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("tuples as struct fields", () => {
		const input = `
struct Container {
    var [int, string] payload
}
const c = Container([99, "bottles"])
Console.write("\\{c.payload._0} \\{c.payload._1}")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("variadic tuple parameters", () => {
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
sum_pairs([1, 2], [3, 4])
sum_pairs()
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("variadic tuples with base parameter", () => {
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
sum_with_base(100, [1, 2], [3, 4])
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("variadic tuples with mixed types", () => {
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
first_parts(["count", 1], ["sum", 2])
`;
		expect(compile_main(input)).toEqual([]);
	});
});
