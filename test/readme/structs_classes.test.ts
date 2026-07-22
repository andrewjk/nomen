import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("readme: structs", () => {
	test("struct with methods and auto-init", () => {
		const input = `
pub struct Point {
    pub var int x
    pub var int y

    pub func translate = (var self, int dx, int dy) {
        self.x = self.x + dx
        self.y = self.y + dy
    }

    pub func distance_from_origin = (self, out int) {
        return self.x * self.x + self.y * self.y
    }
}

const p = Point(3, 4)
p.translate(1, 1)
const d = p.distance_from_origin()
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: anonymous structs", () => {
	test("inline struct literal passed to a function", () => {
		const input = `
struct Circle {
    var string name
    var int center_x
    var int center_y
    var int radius
}

func print_circle = (Circle c) {
    Console.write("\\{c.center_x},\\{c.center_y},\\{c.radius}")
}

print_circle([ name = "C", center_x = 25, center_y = 70, radius = 15 ])
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: classes", () => {
	test("class with var self method", () => {
		const input = `
class Counter {
    var int count = 0

    func increment = (var self) {
        self.count = self.count + 1
    }
}

var c = Counter()
c.increment()
`;
		expect(compile_module(input)).toEqual([]);
	});
});
