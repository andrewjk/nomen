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

describe("spec: readonly fields", () => {
	test("readonly field mutated by its own methods", () => {
		const input = `
struct Counter {
    readonly count = 0

    func bump = (ref self) {
        self.count = self.count + 1
    }
}

var Counter c = Counter()
c.bump()
Console.write("\\{c.count}")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("readonly field write from outside is an error", () => {
		const errors = compile_main(`
struct Counter {
    readonly count = 0
}

var Counter c = Counter()
c.count = 5
`);
		expect(
			errors.some((e) =>
				e.message.includes("Cannot assign to readonly field 'count' from outside Counter"),
			),
		).toBe(true);
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

describe("spec: mv structs (types section)", () => {
	test("mv struct declaration and construction", () => {
		const input = `
mv struct Config {
	var string name
}
var Config c = Config("x")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("mv / .copy() / ref-Box aliasing, each spelled", () => {
		const input = `
mv struct Config {
	var string name
}
var Config c = Config("x")
mv Config c2 = c
var Config c3 = c2.copy()
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("a plain copy of a mv binding is an error", () => {
		const input = `
mv struct Config {
	var string name
}
var Config c = Config("x")
var Config c4 = c
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("cannot copy 'Config' by value"))).toBe(true);
	});

	test("a ref Box binding aliases the instance", () => {
		const input = `
mv struct Node {
	var int value
}
pub func main = () {
	var Box<Node> p = Box<Node>(Node(10))
	ref Box<Node> q = p
	q.value = 99
	Console.write("\\{p.value} \\{q.value}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("mv struct methods with ref self", () => {
		const input = `
mv struct Counter {
	var int count

	func increment = (ref self) {
		self.count = self.count + 1
	}
}
var Counter c = Counter(0)
c.increment()
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("mv struct #destroy", () => {
		const input = `
mv struct Resource {
	var int handle

	func #destroy = (ref self) {
		self.handle = -1
	}
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("passing a mv struct to a function", () => {
		const input = `
mv struct Config {
	var string name
}
func get_name = (Config c, out string) {
	return c.name.copy()
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

describe("spec: construction overrides", () => {
	test("struct constructed and passed to function", () => {
		const input = `
mv struct Circle {
    var string name
    var int center_x
    var int center_y
    var int radius
}

func printCircle = (Circle circle) {
    Console.write("\\{circle.name}: \\{circle.center_x},\\{circle.center_y},\\{circle.radius}\\n")
}

printCircle(Circle("c", 25, 70, 15))
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("overriding fields on construction (base-seeded literal)", () => {
		// SPEC "Overriding fields on construction": the base runs first
		// (required fields positionally), named fields must have declared
		// defaults; the base may be a constructor, a factory result, or a
		// plain variable (mv structs require mv/.copy()).
		const input = `
struct LayoutParams {
    var int grow = 0
    var int shrink = 0
}

func layout = (int grow, out LayoutParams) {
    return [ .. LayoutParams(), grow = grow, shrink = 3 ]
}

const LayoutParams DEF = [ .. LayoutParams(), grow = 2, shrink = 3 ]
const LayoutParams TWO = [ .. DEF, grow = 2 ]
const LayoutParams THREE = layout(7)
Console.write("\\{DEF.grow} \\{DEF.shrink} \\{TWO.grow} \\{TWO.shrink} \\{THREE.grow} \\{THREE.shrink}")
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: extension methods", () => {
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
const int m = p.manhattan()
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

describe("spec: auto-derived methods", () => {
	test("Equatable derives == and !=", () => {
		const input = `
pub struct Point: Equatable {
    pub var int x
    pub var int y
}
const a = Point(1, 2)
const b = Point(1, 2)
const c = Point(3, 4)
const bool same = a == b
const bool diff = a != c
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("Stringable derives to_string", () => {
		const input = `
pub struct Point: Stringable {
    pub var int x
    pub var int y
}
const p = Point(3, 4)
const string s = p.to_string()
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("Hashable derives hash", () => {
		const input = `
pub struct Point: Hashable {
    pub var int x
    pub var int y
}
const p = Point(1, 2)
const uint h = p.hash()
`;
		expect(compile_main(input)).toEqual([]);
	});
});
