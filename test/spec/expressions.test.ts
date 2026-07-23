import { describe, expect, test } from "vite-plus/test";

import { compile_main } from "./_helpers.ts";

describe("spec: variables", () => {
	test("basic declarations", () => {
		const input = `
const string name = "Alice"
var int age = 30
var count = 10
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: literals", () => {
	test("numbers, strings, chars, bools, null", () => {
		const input = `
const int a = 42
const float b = 3.14
const int c = -5
const string s = "Hello, World!"
const char ch = 'h'
const bool flag = true
var int? nothing = null
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: arrays", () => {
	test("array literals and operations", () => {
		const input = `
const numbers = [1, 2, 3, 4, 5]
const int[] empty = []
const combined = [1, 2] + [3, 4]
const repeated = [1, 2] * 3
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: ranges", () => {
	test("range expression", () => {
		const input = `
const range = 0..5
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: operators", () => {
	test("arithmetic and comparison", () => {
		const input = `
var int x = 5
x = x + 2
x = x - 1
x = x * 3
x = x / 2
x = x % 4
var bool b = x > 0 && x < 10 || x == 5
var int y = (x << 2) & 3 | 1 ^ 0
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: operator overloading", () => {
	test("add, sub, mul, div operator functions", () => {
		const input = `
struct Vec2 {
    var int x
    var int y
    func #op_add = (self, Vec2 other, out Vec2) { return Vec2(self.x + other.x, self.y + other.y) }
    func #op_sub = (self, Vec2 other, out Vec2) { return Vec2(self.x - other.x, self.y - other.y) }
    func #op_mul = (self, Vec2 other, out Vec2) { return Vec2(self.x * other.x, self.y * other.y) }
    func #op_div = (self, Vec2 other, out Vec2) { return Vec2(self.x / other.x, self.y / other.y) }
}
const a = Vec2(4, 6)
const b = Vec2(1, 2)
const sum = a + b
const diff = a - b
const prod = a * b
const quot = a / b
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("#op_mod (SPEC gap: % operator overload not yet supported)", () => {
		const input = `
struct Vec2 {
    var int x
    var int y
    func #op_mod = (self, Vec2 other, out Vec2) { return Vec2(self.x % other.x, self.y % other.y) }
}
const a = Vec2(4, 6)
const b = Vec2(1, 2)
const rem = a % b
`;
		const errors = compile_main(input);
		// TODO: enabled once the % operator overload (#op_mod) is supported (SPEC gap).
		expect(errors).toEqual([]);
	});
});

describe("spec: cast operator", () => {
	test("explicit casts", () => {
		const input = `
const int x = 42
const float f = x as float
const int8 b = x as int8
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("custom struct casting", () => {
		const input = `
struct Dog {
    var int value
    func #op_as = (self, out Cat) {
        return Cat(self.value + 1)
    }
}
struct Cat {
    var int value
}
const dog = Dog(9)
const cat = dog as Cat
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: string operations", () => {
	test("concatenation and repetition", () => {
		const input = `
const string name = "World"
const greeting = "Hello, " + name
const dashes = "-" * 10
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: string interpolation", () => {
	test("interpolation in Console.write", () => {
		const input = `
const string name = "Alice"
const int age = 30
Console.write("Hello, \\{name}. You are \\{age} years old.")
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: indexing", () => {
	test("array and string indexing", () => {
		const input = `
const arr = [10, 20, 30]
const first = arr.at(0)
const str = "hello"
const second = str.at(1)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("constant out-of-bounds is an error", () => {
		const input = `
const arr = [10, 20, 30]
const x = arr.at(5)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});
});

describe("spec: field access", () => {
	test("access struct field", () => {
		const input = `
struct Point {
    var int x
    var int y
}
const point = Point(5, 10)
const x = point.x
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: method calls", () => {
	test("instance and static method calls", () => {
		const input = `
struct Point {
    var int x
    var int y
    func add = (self, Point other, out Point) {
        return Point(self.x + other.x, self.y + other.y)
    }
}
const point = Point(5, 10)
const summed = point.add(Point(1, 2))
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: literal coercion", () => {
	test("valid literal coercion", () => {
		const input = `
const int8 x = 42
const uint8 y = 255
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("out-of-range literal is an error", () => {
		const input = `
const int8 z = 256
`;
		const errors = compile_main(input);
		expect(errors.length).toBeGreaterThan(0);
	});
});

describe("spec: type-to-type coercion", () => {
	test("unsigned to larger int", () => {
		const input = `
const uint8 a = 255
const int b = a
const uint c = a
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: structs (overview)", () => {
	test("struct with methods and usage", () => {
		const input = `
pub struct Point {
    pub var int x
    pub var int y
    pub func translate = (ref self, int dx, int dy) {
        self.x = self.x + dx
        self.y = self.y + dy
    }
    pub func distance_from_origin = (self, out int) {
        return (self.x * self.x + self.y * self.y)
    }
}
var p = Point(3, 4)
p.translate(1, 1)
const d = p.distance_from_origin()
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: traits (overview)", () => {
	test("trait implementation and polymorphic assignment", () => {
		const input = `
pub trait Printable {
    func to_string = (self, out string)
}
pub struct Point : Printable {
    pub var int x
    pub var int y
    pub func to_string = (self, out string) {
        return "Point(\\{self.x}, \\{self.y})"
    }
}
const Printable p = Point(1, 2)
const s = p.to_string()
`;
		expect(compile_main(input)).toEqual([]);
	});
});
