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

	test("nested func types and closure factories", () => {
		// SPEC.md, "Function-Typed Parameters (Higher-Order Functions)": a
		// `func` type may itself appear inside another signature — as a
		// parameter type or in the return slot (`out func (...)`, a closure
		// factory whose result the caller owns) — nesting to arbitrary
		// depth.
		const input = `
func twice = (func (out int) f, out int) { return f() + f() }

func make_adder = (int n, out func (out int)) {
    return () => n
}

func run = (func (func (out int), out int) g, func (out int) v, out int) {
    return g(v)
}

func apply = (func (out int) f, out int) { return f() }

pub func main = () {
    var func (out int) add7 = make_adder(7)
    Console.write_line("\\{add7()} \\{twice(add7)} \\{run(apply, () => 3)}")
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("Func<> func type spelling", () => {
		// SPEC.md, "Function-Typed Parameters (Higher-Order Functions)":
		// `Func<T1, ..., Tn>` is the same signature type as
		// `func (T1, ..., out Tn)` with the result LAST; `void` in the
		// result slot means no result. It is usable in every type position
		// and nests at any depth.
		const input = `
func apply = (Func<int, int> mapper, int value, out int) {
    return mapper(value)
}

func run = (func (func (out int), out int) g, func (out int) v, out int) {
    return g(v)
}

func run_alias = (Func<Func<int, int>, int> h, Func<int, int> f, out int) {
    return h(f)
}

func make_three = (out Func<int>) {
    return () => 3
}

func id = (Func<int, int> f, out int) { return f(0) }

pub func main = () {
    var Func<int, int> doubler = (x) => x * 2
    var Func<int> three = make_three()
    var Func<int, void> log = func (int x) { Console.write("\\{x}") }
    var int a = apply(doubler, 5)
    var int b = run_alias(id, doubler)
    var int c = three()
    log(7)
    Console.write_line("\\{a} \\{b} \\{c}")
}
`;
		expect(compile_module(input)).toEqual([]);
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

	test("constructor overloading", () => {
		const input = `
struct Point {
    var int x
    var int y
    pub func #init = (ref self, int x, int y) {
        self.x = x
        self.y = y
    }
    pub func #init = (ref self, int x) {
        self.x = x
        self.y = 0
    }
}
var a = Point(2, 3)
var b = Point(5)
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

	test("anonymous function shapes: arrow expression and keyword block", () => {
		// SPEC.md, "Anonymous Functions (Lambdas)": two shapes — the arrow
		// expression form and the keyword block form — also work as inline
		// call arguments. `=>` takes a single expression; a self-typed
		// keyword block must declare its return.
		const input = `
var func (int, out int) quadrupler = func (x, out int) {
	return x * 4
}

func apply = (func (out int) f, out int) { return f() }

pub func main = () {
	var int a = 1
	var int b = 2
	var int r1 = apply(() => a + b)
	var int r2 = apply(func (out int) { return a + b })
	Console.write_line("\\{quadrupler(1)} \\{r1} \\{r2}")
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("an arrow must be followed by an expression (no `=> { ... }`)", () => {
		const input = `
func apply = (func (out int) f, out int) { return f() }

pub func main = () {
	var int a = 1
	var int r = apply(() => { return a + 1 })
}
`;
		const errors = compile_module(input);
		expect(errors.some((e) => e.message.includes("'=>' must be followed by an expression"))).toBe(
			true,
		);
	});

	test("lambda captures an enclosing local", () => {
		const input = `
var int base = 10
var func (int, out int) add_base = (x, out int) => x + base
Console.write("\\{add_base(1)} \\{add_base(2)}")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("lambda moves an owning struct capture", () => {
		const input = `
struct Owned {
	var List<int> data
}
var Owned o = Owned(List<int>())
var func (out int) first = (out int) => o.data.at_or(0, -1)
Console.write("\\{first()}")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("extern function declaration", () => {
		// The SPEC example is library code (externs are library-only); from a
		// user module the wrapped function is callable as usual.
		const input = `
pub func main = () {
    const int n = parse_int("41")
    Console.write("\\{n}")
}
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
var func (int, out int) square = func (n, out int) {
	return n * n
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("a declaration block body with a declared return must return", () => {
		const input = `
var func (int, out int) square {
	var int a = 1
}
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("Missing return"))).toBe(true);
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

	test("nullable func parameter with a guarded call", () => {
		const input = `
func run = (func? (out int) callback) {
    if callback != null {
        callback()
    } else {
        Console.write("skipped")
    }
}

func five = (out int) {
    return 5
}

run(five)
run(null)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("nullable func call requires a null check", () => {
		const input = `
var func? (out int) f = null
f()
if f != null {
    f()
}
`;
		const errors = compile_main(input);
		expect(errors.length).toBe(1);
		expect(errors[0].message).toContain("may be null");
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
