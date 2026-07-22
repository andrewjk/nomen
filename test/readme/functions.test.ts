import { describe, expect, test } from "vite-plus/test";

import { compile_main } from "./_helpers.ts";

describe("readme: functions", () => {
	test("function bodies, arrow form, defaults, variadic", () => {
		const input = `
func add = (int a, int b, out int) {
    return a + b
}

pub func double = (int x, out int) => x * 2

func greet = (string name = "world") {
    Console.write("Hello, \\{name}!")
}

greet()
greet("Alice")

func sum = (...int numbers, out int) {
    var total = 0
    var i = 0
    while i < numbers.length {
        total = total + numbers.at(i)
        i = i + 1
    }
    return total
}

sum(1, 2, 3)
`;
		expect(compile_main(input)).toEqual([]);
	});
});
