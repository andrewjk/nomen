import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("spec: if/else", () => {
	test("basic if/else with blocks", () => {
		const input = `
var int x = 1
if x > 0 {
    Console.write("positive")
} else {
    Console.write("zero")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("if expression with else", () => {
		const input = `
var int x = 1
const result = if x > 0 -> "positive"
               else -> "zero"
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("else if chain (nested else blocks)", () => {
		const input = `
var int x = 1
if x > 0 {
    Console.write("positive")
} else {
    if x < 0 {
        Console.write("negative")
    } else {
        Console.write("zero")
    }
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("switch for chained conditions (no `else if`)", () => {
		const input = `
var int x = 1
switch {
    case x > 0 -> Console.write("positive")
    case x < 0 -> Console.write("negative")
    else -> Console.write("zero")
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: if expression", () => {
	test("if -> return syntax", () => {
		const input = `
var bool condition = true
const result = if condition -> "yes"
               else -> "no"
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: match statement", () => {
	test("match with else", () => {
		const input = `
var int x = 1
const result = match x {
    case 1 -> "one"
    case 2 -> "two"
    else -> "other"
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("match enum shorthand", () => {
		const input = `
enum Direction {
    case north
    case south
    case east
    case west
}
var direction = Direction.north
match direction {
    case .north -> Console.write("north")
    case .south -> Console.write("south")
    case .east -> Console.write("east")
    case .west -> Console.write("west")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("match bool exhaustive", () => {
		const input = `
var bool flag = true
match flag {
    case true -> Console.write("yes")
    case false -> Console.write("no")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("match enum with associated data (single payload)", () => {
		const input = `
enum Result {
    case ok
    case error(int code)
}
const result = Result.error(10)
const message = match result {
    case .ok -> "it's ok"
    case .error(code) -> "error \\{code} encountered"
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (qualified case name)", () => {
		const input = `
enum Result {
    case ok
    case error(int code)
}
const result = Result.error(10)
const message = match result {
    case Result.ok -> "it's ok"
    case Result.error(code) -> "error \\{code} encountered"
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (multiple cases with payloads)", () => {
		const input = `
enum Shape {
    case circle(int radius)
    case rect(int w, int h)
    case empty
}
const shape = Shape.rect(3, 4)
const area = match shape {
    case .circle(r) -> r * r * 3
    case .rect(w, h) -> w * h
    case .empty -> 0
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (payload used in expression)", () => {
		const input = `
enum Number {
    case int(int value)
    case float(float value)
}
const n = Number.int(42)
const label = match n {
    case .int(v) -> "int: \\{v}"
    case .float(v) -> "float: \\{v}"
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (else branch)", () => {
		const input = `
enum Result {
    case ok
    case error(int code)
}
const result = Result.error(10)
const message = match result {
    case .error(code) -> "error \\{code}"
    else -> "unknown"
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (string payload)", () => {
		const input = `
enum Event {
    case click(string label)
    case quit
}
const event = Event.click("button")
const label = match event {
    case .click(name) -> name
    case .quit -> "quit"
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (binding shadowing outer var)", () => {
		const input = `
enum Result {
    case ok
    case error(int code)
}
const code = 99
const result = Result.error(5)
const message = match result {
    case .error(code) -> "inner code is \\{code}"
    case .ok -> "ok"
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (multiple payloads used)", () => {
		const input = `
enum Pair {
    case pair(int a, int b)
}
const p = Pair.pair(1, 2)
const sum = match p {
    case .pair(x, y) -> x + y
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (nested in function)", () => {
		const input = `
enum Result {
    case ok
    case error(int code)
}
func describe = (Result r, out string) => match r {
    case .ok -> "ok"
    case .error(code) -> "error \\{code}"
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (return in branch)", () => {
		const input = `
enum Result {
    case ok
    case error(int code)
}
func code_of = (Result r, out int) {
    return match r {
        case .ok -> 0
        case .error(code) => code
    }
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (tuple variable payload)", () => {
		const input = `
enum Coord {
    case point([int, int] at)
}
const c = Coord.point([1, 2])
const x = match c {
    case .point(p) -> p[0]
}
`;
		const errors = compile_module(input);
		// TODO: enabled once tuple-typed enum payloads are supported (parse gap).
		expect(errors.length).toBeGreaterThan(0);
	});

	test("match enum with associated data (calling method on payload)", () => {
		const input = `
enum Wrapper {
    case text(string s)
}
const w = Wrapper.text("hello")
const len = match w {
    case .text(s) -> s.length
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (all cases covered, no else)", () => {
		const input = `
enum Option {
    case some(int value)
    case none
}
const o = Option.some(7)
const v = match o {
    case .some(value) -> value
    case .none -> 0
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (payload compared in guard-like branch)", () => {
		const input = `
enum Number {
    case int(int value)
}
const n = Number.int(5)
const is_big = match n {
    case .int(value) -> value > 100
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (two enums, independent)", () => {
		const input = `
enum A {
    case x(int v)
    case y
}
enum B {
    case p(string s)
    case q
}
const a = A.x(1)
const b = B.p("hi")
const av = match a {
    case .x(v) -> v
    case .y -> 0
}
const bv = match b {
    case .p(s) -> s.length
    case .q -> 0
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (payload passed to function)", () => {
		const input = `
enum Result {
    case ok
    case error(int code)
}
func report = (int c, out string) => "code is \\{c}"
const result = Result.error(3)
const msg = match result {
    case .error(code) -> report(code)
    case .ok -> "ok"
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (reassigned enum value)", () => {
		const input = `
enum Result {
    case ok
    case error(int code)
}
var Result result = Result.ok
result = Result.error(8)
const message = match result {
    case .ok -> "ok"
    case .error(code) -> "error \\{code}"
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("match enum with associated data (payload in nested match branch)", () => {
		const input = `
enum Result {
    case ok
    case error(int code)
}
const result = Result.error(2)
const outer = match result {
    case .error(code) -> match result {
        case .error(c) -> c
        case .ok -> 0
    }
    case .ok -> 0
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("exhaustiveness error when associated-data case missing", () => {
		const input = `
enum Result {
    case ok
    case error(int code)
}
const result = Result.error(10)
const message = match result {
    case .ok -> "ok"
}
`;
		const errors = compile_module(input);
		expect(errors.some((e) => e.message.includes("Non-exhaustive"))).toBe(true);
	});

	test("error when payload arity mismatches enum case", () => {
		const input = `
enum Result {
    case ok
    case error(int code)
}
const result = Result.error(10)
const message = match result {
    case .ok -> "ok"
    case .error(a, b) -> "two"
}
`;
		const errors = compile_module(input);
		expect(errors.length).toBeGreaterThan(0);
	});
});

describe("spec: switch statement", () => {
	test("switch as expression", () => {
		const input = `
var int x = 5
const size = switch {
    case x > 100 -> "big"
    case x > 10 -> "medium"
    else -> "small"
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: while loop", () => {
	test("basic while", () => {
		const input = `
var int x = 0
while x < 10 {
    Console.write("\\{x}")
    x += 1
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("while with update clause", () => {
		const input = `
var int x = 0
while x < 10; x += 1 {
    Console.write("\\{x}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: for loop", () => {
	test("for-of array", () => {
		const input = `
const int[] items = [1, 2, 3]
for item of items {
    Console.write("\\{item}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("for-of range", () => {
		const input = `
for i of 0..10 {
    Console.write("\\{i}")
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("for-of with update clause", () => {
		const input = `
const int[] items = [1, 2, 3]
var total = 0
for item of items; total += item {
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: break and continue", () => {
	test("break and continue inside while", () => {
		const input = `
var bool should_exit = false
var bool should_skip = false
while true {
    if should_exit {
        break
    }
    if should_skip {
        continue
    }
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: return", () => {
	test("return value", () => {
		const input = `
func get = (out int) {
    return 5
}
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: let vs -> outside expressions", () => {
	test("standalone `let` in function body is a compile error (not an implicit return)", () => {
		const input = `
func build = (int x, out string) {
    let "value is \\{x}"
}
`;
		const errors = compile_main(input);
		// By design `let` is not an implicit return; a function must use `return`.
		expect(errors.length).toBeGreaterThan(0);
	});
});

describe("spec: let and arrow shorthand", () => {
	test("let and -> interchangeable in expression position", () => {
		const input = `
var int x = 1
const a = if x > 0 -> "yes"
          else -> "no"
const b = if x > 0 let "yes"
          else let "no"
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: panic", () => {
	test("panic with and without parens", () => {
		const input = `
panic "something went wrong"
panic("with parens")
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: todo", () => {
	test("todo with and without parens", () => {
		const input = `
todo "not implemented yet"
todo("with parens")
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: method/function calls as expressions", () => {
	test("match, switch, if as expressions", () => {
		const input = `
var int x = 5
const label = match x {
    case 1 -> "one"
    case 2 -> "two"
    else -> "other"
}
const size = switch {
    case x > 100 -> "big"
    case x > 10 -> "medium"
    else -> "small"
}
const verdict = if x > 0 -> "yes"
                else -> "no"
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: imports", () => {
	test("top-level imports", () => {
		const input = `
import System
import System/Controls
import System/Collections/List
`;
		expect(compile_module(input)).toEqual([]);
	});
});
