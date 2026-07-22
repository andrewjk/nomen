import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("readme: strings", () => {
	test("concatenation, repetition, interpolation", () => {
		const input = `
const string name = "Alice"
var int age = 30
const string greeting = "Hello, " + name
const string dashes = "-" * 10
Console.write("You are \\{age} years old.")
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: arrays", () => {
	test("literals, at/set, + and *", () => {
		const input = `
var numbers = [1, 2, 3, 4, 5]
const first = numbers.at(0)
numbers.set(1, 99)

const combined = [1, 2] + [3, 4]
const repeated = [1, 2] * 3
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: tuples", () => {
	test("literal, field access, destructuring", () => {
		const input = `
var things = [1, "first"]
Console.write("\\{things._0} \\{things._1}")

func get_person = (int id, out [string, int]) {
    return ["Andrew", id + 100]
}

var [name2, age2] = get_person(12)
`;
		expect(compile_module(input)).toEqual([]);
	});
});
