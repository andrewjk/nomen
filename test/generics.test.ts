import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check from "../src/check";
import parse from "../src/parse";
import check_output_aarch64 from "./ziglings/check_output_aarch64";
import parse_with_imports from "./ziglings/parse_with_imports";

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

pub func main = () {
    var Circle<int> c = Circle<int>(25, 70, 15)
    return
}
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

pub func main = () {
    var Circle<int> c = Circle<int>(25, 70, 15)
    var int x = c.center_x
    return
}
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

pub func main = () {
    var Circle<int> c = Circle<int>(25, 70, 15)
    return
}
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

pub func main = () {
    var Pair<int, int> a = Pair<int, int>(1, 2)
    var Pair<int, string> b = Pair<int, string>(3, "hello")
    return
}
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

pub func main = () {
    var Circle<int, string> c = Circle<int, string>(25, 70, 15)
    return
}
`;
	const parsed = parse(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("generics -- generic function detects from param type", () => {
	const input = `
struct Box<T> {
    var T value
}

func unwrap = (Box box) {
    return box.value
}

pub func main = () {
    var Box<int> b = Box<int>(42)
    return
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- generic function specializes on call site", () => {
	const input = `
struct Box<T> {
    var T value
}

func unwrap = (Box box) {
    return box.value
}

pub func main = () {
    var Box<int> b = Box<int>(42)
    var int v = unwrap(b)
    return
}
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

pub func main = () {
    usePair([ first = 1, second = "hello" ])
    return
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- generic function two specializations", () => {
	const input = `
struct Box<T> {
    var T value
}

func printBox = (Box box) {
    return
}

pub func main = () {
    var Box<int> a = Box<int>(1)
    var Box<string> b = Box<string>("hi")
    printBox(a)
    printBox(b)
    return
}
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

func use = (Box box) {
    return
}

pub func main = () {
    var Box<int> a = Box<int>(1)
    var Box<int> b = Box<int>(2)
    use(a)
    use(b)
    return
}
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
import System

struct Box<T> {
    var T value
}

func getValue = (Box box) {
    var int v = box.value
    Console.write(v.to_string())
}

pub func main = () {
    getValue([ value = 42 ])
    return
}
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

func sum = (Point p) {
    return p.x + p.y
}

pub func main = () {
    var int total = sum([ x = 10, y = 20 ])
    return
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- generic function build aarch64", async () => {
	const input = `
import System

struct Box<T> {
    var T value
}

func printBox = (Box box) {
    var int v = box.value
    Console.write(v.to_string())
    Console.write("\\n")
}

pub func main = () {
    printBox([ value = 99 ])
    return
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64", audit: true });
	expect(built.code).toContain("printBox_Box_int");
	await check_output_aarch64("gen_func_box", built, "99\n");
});

test("generics -- generic function two types build aarch64", async () => {
	const input = `
import System

struct Pair<T, U> {
    var T first
    var U second
}

func printFirst = (Pair p) {
    var int f = p.first
    Console.write(f.to_string())
    Console.write("\\n")
}

pub func main = () {
    printFirst([ first = 10, second = "a" ])
    printFirst([ first = 20, second = "b" ])
    return
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64", audit: true });
	expect(built.code).toContain("printFirst_Pair_int_string");
	await check_output_aarch64("gen_func_pair", built, "10\n20\n");
});

test("generics -- explicit type params on function", () => {
	const input = `
struct Box<T> {
    var T value
}

func identity<T> = (Box<T> box) {
    return box.value
}

pub func main = () {
    var Box<int> b = Box<int>(42)
    var int v = identity(b)
    return
}
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

pub func main = () {
    var Pair<int, string> a = Pair<int, string>(1, "hello")
    usePair(a)
    return
}
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

pub func main = () {
    var Box<int> b = Box<int>(42)
    var int v = unwrap(b)
    return
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- explicit type params two specializations", () => {
	const input = `
struct Box<T> {
    var T value
}

func identity<T> = (Box<T> box) {
    return box.value
}

pub func main = () {
    var Box<int> a = Box<int>(1)
    var Box<string> b = Box<string>("hi")
    var int x = identity(a)
    var string y = identity(b)
    return
}
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

func identity<T> = (Box<T> box) {
    return box.value
}

pub func main = () {
    var Box<int> a = Box<int>(1)
    var Box<int> b = Box<int>(2)
    var int x = identity(a)
    var int y = identity(b)
    return
}
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

func sumCoords<T> = (Point<T> p) {
    return p.x + p.y
}

pub func main = () {
    var int total = sumCoords([ x = 10, y = 20 ])
    return
}
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

pub func main = () {
    var Vec<int> a = Vec<int>(1, 2)
    var Vec<int> b = Vec<int>(3, 4)
    addX(a, b)
    return
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});
