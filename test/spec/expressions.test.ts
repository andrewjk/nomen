import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("spec: variables", () => {
	test("basic declarations", () => {
		const input = `
const string name = "Alice"
var int age = 30
var count = 10
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("view and var view declarations", () => {
		const input = `
const string greeting = "hello"
view a = greeting.slice(0, 3)
var view b = greeting.slice(0, 3)
b = greeting.slice(1, 4)
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

	test("hex, octal, and binary integer literals", () => {
		const input = `
const int hex = 0xFF
const int oct = 0o377
const int bin = 0b11111111
const int grouped = 0xCAFE_F00D
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("integer literal bases inferred as int", () => {
		const input = `
const mask = 0xFF00FF00
const perms = 0o755
const flags = 0b101010
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

	test("equality operator functions (#op_eq / #op_ne)", () => {
		const input = `
struct Vec2 {
    var int x
    var int y
    func #op_eq = (self, Vec2 other, out bool) { return self.x == other.x && self.y == other.y }
}
const a = Vec2(1, 2)
const b = Vec2(1, 2)
const c = Vec2(3, 4)
const bool same = a == b
const bool diff = a != c
`;
		expect(compile_main(input)).toEqual([]);
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

describe("spec: slicing", () => {
	test("slice, to_string, length, and at", () => {
		const input = `
const str = "hello world"
if str.length == 11 {
	view v = str.slice(0, 5)
	Console.write(v.to_string())
	Console.write("\\{v.length}")
	Console.write(v.at(1).to_string())
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("array and list slices return a view of elements", () => {
		const input = `
const int[] nums = [10, 20, 30, 40, 50]
view s = nums.slice(1, 4)
Console.write("\\{s.length}")
Console.write("\\{s.at(0)}")
Console.write("\\{s.at(2)}")

var List<int> list = List<int>()
list.push(1)
list.push(2)
list.push(3)
view t = list.slice(0, 2)
Console.write("\\{t.at(1)}")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("var view is a re-pointable mutable view", () => {
		const input = `
var string greeting = "hello world"
var view hi = greeting.slice(0, 5)
hi = greeting.slice(6, 11)
Console.write(hi.to_string())
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("const view explicit type is equivalent to view keyword", () => {
		const input = `
const str = "hello world"
const view string v = str.slice(0, 5)
Console.write(v.to_string())
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("view keyword with an explicit element type is a const view", () => {
		const input = `
var string greeting = "hello world"
view string hi = greeting.slice(0, 5)
Console.write(hi.to_string())
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("binding a view without the view keyword is an error", () => {
		const errors = compile_main(`
const str = "hello world"
var v = str.slice(0, 5)
`);
		expect(errors.some((e) => e.message.includes("view"))).toBe(true);
	});

	test("view keyword on a non-view value is an error", () => {
		const errors = compile_main(`view v = "hello"`);
		expect(errors.some((e) => e.message.includes("view"))).toBe(true);
	});

	test("user-defined Viewable container delegates slice to its Buffer", () => {
		const input = `
pub struct UserList: Viewable {
	var int length = 0
	var Buffer<int> items = Buffer<int>()
	pub func slice = (self, int start: start >= 0, int end: end >= start, out view int) {
		return self.items.slice(start, end)
	}
}
`;
		// The struct declares a slice that returns a view borrowing from self —
		// sound and allowed (the caller re-roots it at the receiver).
		expect(compile_module(input)).toEqual([]);
	});

	test("returning a view is an error", () => {
		const errors = compile_module(`
func bad = (string s: s.length >= 3, out view string) {
	return s.slice(0, 3)
}
pub func main = () { Console.write("x") }
`);
		expect(errors.some((e) => e.message.includes("borrowed reference"))).toBe(true);
	});

	test("returning a view that borrows from a parameter is an error", () => {
		const errors = compile_module(`
func bad = (int[] a: a.length >= 2, out view int) {
	return a.slice(0, 2)
}
pub func main = () { Console.write("x") }
`);
		expect(errors.some((e) => e.message.includes("borrowed reference"))).toBe(true);
	});

	test("using a view after reassigning its source is an error", () => {
		const input = `
var string s = "hello"
if s.length == 5 {
	view v = s.slice(0, 3)
	s = "world"
	Console.write("\\{v.length}")
}
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("invalidat"))).toBe(true);
	});

	test("a struct may declare view fields (zero-copy slices in containers)", () => {
		const input = `
pub struct Line {
	var view string text
	var start = 0
	var len = 0
}

var string doc = "name other"
var Line first = Line(doc.slice(0, 4))
first.text.to_string()
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("returning a struct whose view field borrows from this scope is an error", () => {
		const errors = compile_module(`
struct Line {
	var view string text
}
func make_line = (out Line) {
	var string doc = "hi"
	return Line(doc.slice(0, 2))
}
pub func main = () { Console.write("x") }
`);
		expect(errors.some((e) => e.message.includes("'view' field(s) borrow"))).toBe(true);
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

	test("non-decimal literals coerce when in range", () => {
		const input = `
const uint8 byte = 0xFF
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("non-decimal literal out of range is an error", () => {
		const input = `
const uint8 overflow = 0x100
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
