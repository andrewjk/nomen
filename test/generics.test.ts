import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check from "../src/check";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

test("generics -- parse generic struct", () => {
	const input = `
struct Circle<T> {
    var T center_x
    var T center_y
    var T radius
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- check resolves type params on instantiation", () => {
	const input = `
struct Circle<T> {
    var T center_x
    var T center_y
    var T radius
}

var Circle<int> c = Circle<int>(25, 70, 15)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const checked = check(parsed.root);
	const errors = checked.errors.filter((e) => !e.message.includes("void"));
	expect(errors).toEqual([]);
});

test("generics -- field access on generic instance", () => {
	const input = `
struct Circle<T> {
    var T center_x
    var T center_y
    var T radius
}

var Circle<int> c = Circle<int>(25, 70, 15)
var int x = c.center_x
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const checked = check(parsed.root);
	const errors = checked.errors.filter((e) => !e.message.includes("void"));
	expect(errors).toEqual([]);
});

test("generics -- build C with monomorphized struct", () => {
	const input = `
struct Circle<T> {
    var T center_x
    var T center_y
    var T radius
}

var Circle<int> c = Circle<int>(25, 70, 15)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root);
	expect(built.code).toContain("Circle_int_init");
});

test("generics -- two instantiations of same generic", () => {
	const input = `
struct Pair<T, U> {
    var T first
    var U second
}

var Pair<int, int> a = Pair<int, int>(1, 2)
var Pair<int, string> b = Pair<int, string>(3, "hello")
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root);
	expect(built.code).toContain("Pair_int_int_init");
	expect(built.code).toContain("Pair_int_string_init");
});

test("generics -- wrong number of type args", () => {
	const input = `
struct Circle<T> {
    var T center_x
    var T center_y
    var T radius
}

var Circle<int, string> c = Circle<int, string>(25, 70, 15)
`;
	const parsed = parse(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("generics -- generic function detects from param type", () => {
	const input = `
struct Box<T> {
    var T value
}

func unwrap<T> = (Box<T> box, out T) {
    return box.value
}

var Box<int> b = Box<int>(42)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- generic function specializes on call site", () => {
	const input = `
struct Box<T> {
    var T value
}

func unwrap<T> = (Box<T> box, out T) {
    return box.value
}

var Box<int> b = Box<int>(42)
var int v = unwrap(b)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- generic function with anon struct arg", () => {
	const input = `
struct Pair<T, U> {
    var T first
    var U second
}

func usePair<T, U> = (Pair<T, U> p) {
    var T f = p.first
    return
}

usePair([ first = 1, second = "hello" ])
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- generic function two specializations", () => {
	const input = `
struct Box<T> {
    var T value
}

func printBox<T> = (Box<T> box) {
    return
}

var Box<int> a = Box<int>(1)
var Box<string> b = Box<string>("hi")
printBox(a)
printBox(b)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const checked = check(parsed.root);
	const errors = checked.errors.filter((e) => !e.message.includes("void"));
	expect(errors).toEqual([]);
	const spec_int = parsed.root.statements.find(
		(s: any) => s.node_type === "func" && s.name === "printBox_Box_int",
	);
	const spec_str = parsed.root.statements.find(
		(s: any) => s.node_type === "func" && s.name === "printBox_Box_string",
	);
	expect(spec_int).toBeTruthy();
	expect(spec_str).toBeTruthy();
});

test("generics -- generic function same specialization reused", () => {
	const input = `
struct Box<T> {
    var T value
}

func use<T> = (Box<T> box) {
    return
}

var Box<int> a = Box<int>(1)
var Box<int> b = Box<int>(2)
use(a)
use(b)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const specs = parsed.root.statements.filter(
		(s: any) => s.node_type === "func" && s.name.startsWith("use_Box_"),
	);
	expect(specs.length).toBe(1);
});

test("generics -- generic function field access resolves concrete type", () => {
	const input = `
struct Box<T> {
    var T value
}

func getValue<T> = (Box<T> box) {
    var int v = box.value
    Console.write(v.to_string())
}

getValue([ value = 42 ])
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- generic function with anon struct inferred types", () => {
	const input = `
struct Point<T> {
    var T x
    var T y
}

func sum<T> = (Point<T> p, out T) {
    return p.x + p.y
}

var int total = sum([ x = 10, y = 20 ])
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- generic function build aarch64", async () => {
	const input = `
struct Box<T> {
    var T value
}

func printBox<T> = (Box<T> box) {
    var int v = box.value
    Console.write(v.to_string())
    Console.write("\\n")
}

printBox([ value = 99 ])
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64", audit: true });
	expect(built.code).toContain("printBox_Box_int");
	await build_and_check_output(input, "gen_func_box", "99\n");
});

test("generics -- generic function two types build aarch64", async () => {
	const input = `
struct Pair<T, U> {
    var T first
    var U second
}

func printFirst<T, U> = (Pair<T, U> p) {
    var int f = p.first
    Console.write(f.to_string())
    Console.write("\\n")
}

printFirst([ first = 10, second = "a" ])
printFirst([ first = 20, second = "b" ])
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64", audit: true });
	expect(built.code).toContain("printFirst_Pair_int_string");
	await build_and_check_output(input, "gen_func_pair", "10\n20\n");
});

test("generics -- explicit type params on function", () => {
	const input = `
struct Box<T> {
    var T value
}

func identity<T> = (Box<T> box, out T) {
    return box.value
}

var Box<int> b = Box<int>(42)
var int v = identity(b)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- explicit type params with different names", () => {
	const input = `
struct Pair<T, U> {
    var T first
    var U second
}

func usePair<A, B> = (Pair<A, B> p) {
    var A f = p.first
    var B s = p.second
    return
}

var Pair<int, string> a = Pair<int, string>(1, "hello")
usePair(a)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- explicit type params with return type", () => {
	const input = `
struct Box<T> {
    var T value
}

func unwrap<T> = (out T, Box<T> box) {
    return box.value
}

var Box<int> b = Box<int>(42)
var int v = unwrap(b)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- explicit type params two specializations", () => {
	const input = `
struct Box<T> {
    var T value
}

func identity<T> = (Box<T> box, out T) {
    return box.value
}

var Box<int> a = Box<int>(1)
var Box<string> b = Box<string>("hi")
var int x = identity(a)
var string y = identity(b)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const spec_int = parsed.root.statements.find(
		(s: any) => s.node_type === "func" && s.name === "identity_Box_int",
	);
	const spec_str = parsed.root.statements.find(
		(s: any) => s.node_type === "func" && s.name === "identity_Box_string",
	);
	expect(spec_int).toBeTruthy();
	expect(spec_str).toBeTruthy();
});

test("generics -- explicit type params reused specialization", () => {
	const input = `
struct Box<T> {
    var T value
}

func identity<T> = (Box<T> box, out T) {
    return box.value
}

var Box<int> a = Box<int>(1)
var Box<int> b = Box<int>(2)
var int x = identity(a)
var int y = identity(b)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const specs = parsed.root.statements.filter(
		(s: any) => s.node_type === "func" && s.name.startsWith("identity_Box_"),
	);
	expect(specs.length).toBe(1);
});

test("generics -- explicit type params with anon struct", () => {
	const input = `
struct Point<T> {
    var T x
    var T y
}

func sumCoords<T> = (Point<T> p, out T) {
    return p.x + p.y
}

var total = sumCoords([ x = 10, y = 20 ])
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- explicit type params with operations in body", () => {
	const input = `
struct Vec<T> {
    var T x
    var T y
}

func addX<T> = (Vec<T> a, Vec<T> b) {
    var T result = a.x + b.x
    return
}

var Vec<int> a = Vec<int>(1, 2)
var Vec<int> b = Vec<int>(3, 4)
addX(a, b)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- arrow function infers return type without out", () => {
	const input = `
struct Box<T> {
    var T value
}

func unwrap<T> = (Box<T> box) => box.value

var Box<int> b = Box<int>(42)
var int v = unwrap(b)
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- bare generic in struct field errors", () => {
	const input = `
struct Box<T> {
    var T value
}

struct Holder {
    var Box field
}
`;
	const expected = [
		test_error(input, "Generic type 'Box' requires type arguments (expected <T>)", 7, 9),
	];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("generics -- bare generic in class field errors", () => {
	const input = `
struct Box<T> {
    var T value
}

class Holder {
    var Box field
}
`;
	const expected = [
		test_error(input, "Generic type 'Box' requires type arguments (expected <T>)", 7, 9),
	];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("generics -- bare generic in function parameter errors", () => {
	const input = `
struct Box<T> {
    var T value
}

func use = (Box b) {
    return
}
`;
	const expected = [
		test_error(input, "Generic type 'Box' requires type arguments (expected <T>)", 6, 13),
	];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("generics -- bare generic in return type errors", () => {
	const input = `
struct Box<T> {
    var T value
}

func make = (out Box) {
    return Box<int>(1)
}
`;
	const expected = [
		test_error(input, "Generic type 'Box' requires type arguments (expected <T>)", 6, 18),
	];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("generics -- bare generic in local variable errors", () => {
	const input = `
struct Box<T> {
    var T value
}

func make = () {
    var Box b = Box<int>(1)
    return
}
`;
	const expected = [
		test_error(input, "Generic type 'Box' requires type arguments (expected <T>)", 7, 9),
	];
	const parsed = parse(input);
	expect(parsed.errors).toEqual(expected);
});

test("generics -- bare generic resolves once type params are in scope (self-reference)", () => {
	const input = `
struct Box<T> {
    var T value

    func pair = (self, out Box) {
        return self
    }
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});
