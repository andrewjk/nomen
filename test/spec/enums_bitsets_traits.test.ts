import { describe, expect, test } from "vite-plus/test";

import { compile_module, compile_main } from "./_helpers.ts";

describe("spec: enums", () => {
	test("basic enum declaration and use", () => {
		const input = `
pub enum Direction {
    case north
    case east
    case south
    case west
}
var direction = Direction.north
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("enum comparison and reassignment", () => {
		const input = `
pub enum Direction {
    case north
    case east
    case south
    case west
}
var direction = Direction.north
if direction == Direction.north {
    direction = Direction.south
}
const label = if direction == Direction.north -> "N"
              else -> "S"
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("enum shorthand syntax", () => {
		const input = `
pub enum Direction {
    case north
    case east
    case south
    case west
}
var Direction dir = .east
dir = .west
if dir == .north {
    Console.write("north")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("enum with associated data (single field)", () => {
		const input = `
pub enum Result {
    case ok
    case error(int code)
}
var result = Result.error(5)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("enum with associated data (multiple fields)", () => {
		const input = `
pub enum Shape {
    case circle(int radius)
    case rect(int width, int height)
}
var shape = Shape.rect(10, 20)
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: bitsets", () => {
	test("bitset declaration and combine", () => {
		const input = `
pub bitset Permissions {
    case read
    case write
    case execute
}
var perms = Permissions.read | Permissions.write
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("bitset check and toggle", () => {
		const input = `
pub bitset Permissions {
    case read
    case write
    case execute
}
var flags = Permissions.read
flags = flags | Permissions.write
const can_write = (flags & Permissions.write) == Permissions.write
flags = flags ^ Permissions.execute
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: trait types", () => {
	test("trait declaration", () => {
		const input = `
pub trait Addable {
    func add = (self, out int)
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("struct implements trait", () => {
		const input = `
pub trait Animal {
    func speak = (self, out string)
}
pub trait Named {
    func name = (self, out string)
}
struct Dog : Animal, Named {
    func speak = (self, out string) { return "woof" }
    func name = (self, out string) { return "Rex" }
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("assign concrete struct to trait variable", () => {
		const input = `
pub trait Named {
    func name = (self, out string)
}
struct Dog : Named {
    func name = (self, out string) { return "Rex" }
}
const Named named = Dog()
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("trait function without body", () => {
		const input = `
pub trait Printable {
    func to_string = (self, out string)
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
