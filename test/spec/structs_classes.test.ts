import { describe, expect, test } from "vite-plus/test";

import { compile_module, compile_main } from "./_helpers.ts";

describe("spec: struct types", () => {
	test("struct with methods and auto-init", () => {
		const input = `
pub struct Point {
    pub var int x
    pub var int y

    pub func add = (ref self, Point other, out Point) {
        return Point(self.x + other.x, self.y + other.y)
    }
}
const point = Point(5, 10)
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: initializers", () => {
	test("custom #init", () => {
		const input = `
pub struct Point {
    pub var int x
    pub var int y
    pub var int sum

    func #init = (ref self, int x, int y) {
        self.x = x
        self.y = y
        self.sum = x + y
    }
}
const p = Point(3, 4)
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: destroy functions", () => {
	test("struct #destroy", () => {
		const input = `
pub struct Transaction {
    pub var int handle

    func #init = (ref self, int handle) {
        self.handle = handle
    }

    func #destroy = () {
    }
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: class types", () => {
	test("class declaration and construction", () => {
		const input = `
class Point {
    var int x
    var int y
}
var p = Point(1, 2)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("assignment shares instance", () => {
		const input = `
class Point {
    var int x
    var int y
}
var p = Point(10, 20)
var q = p
q.x = 99
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("class methods with ref self", () => {
		const input = `
class Counter {
    var int count

    func increment = (ref self) {
        self.count = self.count + 1
    }
}
var c = Counter(0)
c.increment()
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("class #destroy", () => {
		const input = `
class Resource {
    var int handle

    func #destroy = (ref self) {
        self.handle = -1
    }
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("passing class to function", () => {
		const input = `
class Point {
    var int x
    var int y
}
func getX = (Point p, out int) {
    return p.x
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("read-only param with local var copy", () => {
		const input = `
func add_five = (int x, out int) {
    var int y = x
    y = y + 5
    return y
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: generic structs", () => {
	test("generic struct declaration", () => {
		const input = `
pub struct List<T> {
    var int length = 0
    var int capacity = 0
    var T elem

    pub func push = (ref self, T value) {
        self.elem = value
    }
    pub func pop = (self, out T) {
        return self.elem
    }
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("generic struct instantiation", () => {
		const input = `
pub struct List<T> {
    var int length = 0
    var int capacity = 0
    var T elem

    pub func push = (ref self, T value) {
        self.elem = value
    }
    pub func pop = (self, out T) {
        return self.elem
    }
}
var List<int> numbers = List<int>(0)
numbers.push(42)
const int top = numbers.pop()
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: anonymous structs", () => {
	test("anonymous struct literal passed to function", () => {
		const input = `
struct Circle {
    var string name
    var int center_x
    var int center_y
    var int radius
}

func printCircle = (Circle circle) {
    Console.write("\\{circle.name}: \\{circle.center_x},\\{circle.center_y},\\{circle.radius}\\n")
}

printCircle([ name = "c", center_x = 25, center_y = 70, radius = 15 ])
`;
		expect(compile_main(input)).toEqual([]);
	});
});
