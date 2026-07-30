import { describe, expect, test } from "vite-plus/test";

import { compile_module, compile_main } from "./_helpers.ts";

describe("spec: functions", () => {
	test("basic function and arrow", () => {
		const input = `
pub func greet = (string name) {
    Console.write("Hello, \\{name}.\\n")
}
pub func add = (int a, int b, out int) {
    return a + b
}
pub func double = (int x, out int) => x * 2
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("self auto-typed in struct method", () => {
		const input = `
pub struct Point {
    var int x
    pub func get_x = (self, out int) {
        return self.x
    }
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("default parameter values", () => {
		const input = `
func greet = (string name = "world") {
    Console.write("Hello, \\{name}!")
}
greet()
greet("Alice")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("variadic parameters", () => {
		const input = `
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
sum(42)
sum()
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("variadic with leading regular parameter", () => {
		const input = `
func add_to = (int base, ...int numbers, out int) {
    var total = base
    var i = 0
    while i < numbers.length {
        total = total + numbers.at(i)
        i = i + 1
    }
    return total
}
add_to(10, 1, 2, 3)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("variadic with string type", () => {
		const input = `
func count = (...string items, out int) => items.length
count("a", "b", "c")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("ref parameters and local var copies", () => {
		const input = `
func increment = (int x, out int) {
    var int y = x
    y = y + 1
    return y
}
func makeFive = (ref int x) {
    x = 5
}
var int num = 1
makeFive(ref num)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("function-typed parameters", () => {
		const input = `
func apply = (func (int, out int) mapper, int value, out int) {
    return mapper(value)
}
func inc = (int x, out int) => x + 1
apply(inc, 5)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("function overloading", () => {
		const input = `
struct Vec2 {
    var int x
    var int y
    pub func scale = (ref self, int s) {
        self.x = self.x * s
        self.y = self.y * s
    }
    pub func scale = (ref self, Vec2 other) {
        self.x = self.x * other.x
        self.y = self.y * other.y
    }
}
var v = Vec2(2, 3)
v.scale(4)
v.scale(v)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("operator overloading", () => {
		const input = `
struct Vec2 {
    var int x
    var int y
    pub func #op_add = (self, Vec2 other, out Vec2) {
        return Vec2(self.x + other.x, self.y + other.y)
    }
    pub func #op_add = (self, int scalar, out Vec2) {
        return Vec2(self.x + scalar, self.y + scalar)
    }
}
const a = Vec2(4, 6)
const b = Vec2(1, 2)
const sum = a + b
const scaled = a + 3
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("function-typed variable (lambda)", () => {
		const input = `
var func (int, int, out int) adder = (a, b, out int) => a + b
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("function-typed variable with named types", () => {
		const input = `
var func (int a, int b, out int) adder = (a, b, out int) => a + b
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("function-typed variable called with arguments", () => {
		const input = `
var func (int, int, out int) adder = (a, b, out int) => a + b
const int sum = adder(2, 3)
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("function-typed variable passed as parameter", () => {
		const input = `
func apply = (int num, func (int, out int) f, out int) => f(num)
var func (int, out int) doubler = (n, out int) => n * 2
const int result = apply(5, doubler)
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("function-typed variable block body", () => {
		const input = `
var func (int, out int) square = (n, out int) {
	return n * n
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("function-typed variable declared then assigned later", () => {
		const input = `
var func (int a, int b, out int) adder
adder = (a, b, out int) => a + b
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("function-typed variable declared then assigned and called", () => {
		const input = `
var func (int, int, out int) adder
adder = (a, b, out int) => a + b
const int sum = adder(2, 3)
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("function-typed variable reassigned to a different lambda", () => {
		const input = `
var func (int a, int b, out int) adder
adder = (a, b, out int) => a + b
adder = (x, y, out int) => x - y
const int sum = adder(5, 2)
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("nested functions and structs", () => {
		const input = `
func process = (int value, out int) {
    struct Wrapper {
        var int inner
    }
    func double = (int x, out int) {
        return x * 2
    }
    const w = Wrapper(value)
    return double(w.inner)
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
