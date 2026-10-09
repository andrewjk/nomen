import { describe, expect, test } from "vite-plus/test";

import { compile_main } from "./_helpers.ts";

describe("readme: structs", () => {
	test("struct with methods and auto-init", () => {
		const input = `
pub struct Point {
    pub var int x
    pub var int y

    pub func translate = (ref self, int dx, int dy) {
        self.x = self.x + dx
        self.y = self.y + dy
    }

    pub func distance_from_origin = (self, out int) {
        return self.x * self.x + self.y * self.y
    }
}

var p = Point(3, 4)
p.translate(1, 1)
const d = p.distance_from_origin()
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: construction overrides", () => {
	test("struct constructed and passed to a function", () => {
		const input = `
mv struct Circle {
    var string name
    var int center_x
    var int center_y
    var int radius
}

func print_circle = (Circle c) {
    Console.write("\\{c.center_x},\\{c.center_y},\\{c.radius}")
}

print_circle(Circle("C", 25, 70, 15))
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: ownership", () => {
	test("mv struct with ref self method and mv field", () => {
		const input = `
mv struct Box {
	var int value
}

mv struct Holder {
	var Box content
}

func take = (mv Box b, out int) {
	return b.value
}

pub func main = () {
	var h = Holder(mv Box(7))
	var b = Box(42)
	var int v = take(mv b)
	Console.write("\\{v} \\{h.content.value}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: extension methods", () => {
	test("extend struct adds a method", () => {
		const input = `
struct Point {
    var int x
    var int y
}

extend struct Point {
    pub func manhattan = (self, out int) {
        return self.x + self.y
    }
}

const p = Point(3, 4)
const m = p.manhattan()
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("extend adds out-of-line trait conformance", () => {
		const input = `
trait Stringable {
    func to_string = (out string)
}

mv struct Circle {
    var int radius
}

extend struct Circle : Stringable {
    func to_string = (out string) {
        return "Circle"
    }
}

const Stringable s = Circle(5)
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: auto-derived methods", () => {
	test("Equatable and Stringable derive methods", () => {
		const input = `
pub struct Point : Equatable, Stringable {
    pub var int x
    pub var int y
}

const a = Point(1, 2)
const b = Point(1, 2)
const bool same = a == b
const bool diff = a != b
const string s = a.to_string()
`;
		expect(compile_main(input)).toEqual([]);
	});
});
