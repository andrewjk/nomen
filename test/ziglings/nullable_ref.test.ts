import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("struct with nullable ref field - basic", async () => {
	const input = `
import System

struct Node {
    var int value
    var ref Node? next = null
}

pub func main = () {
    var Node a = Node(1)
    var Node b = Node(2)
    Console.write("a.value=\\{a.value} b.value=\\{b.value}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	await check_output("nullable_ref_basic", result, "a.value=1 b.value=2\n");
});

test("struct with nullable ref field - null check", async () => {
	const input = `
import System

struct Node {
    var int value
    var ref Node? next = null
}

pub func main = () {
    var Node a = Node(1)
    const int? next_val = 0
    if a.next == null {
        Console.write("next is null\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	await check_output("nullable_ref_null_check", result, "next is null\n");
});

test("ref struct param field access", async () => {
	const input = `
import System

struct Point {
    var int x
    var int y
}

func printX = (ref Point p) {
    Console.write("\\{p.x}")
}

pub func main = () {
    var Point pt = Point(5, 10)
    printX(ref pt)
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	await check_output("ref_struct_param", result, "5");
});

test("ref struct param field assignment", async () => {
	const input = `
import System

struct Point {
    var int x
    var int y
}

func setX = (ref Point p, int val) {
    p.x = val
}

pub func main = () {
    var Point pt = Point(0, 0)
    setX(ref pt, 42)
    Console.write("\\{pt.x}")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	await check_output("ref_struct_assign", result, "42");
});

test("ref struct param bool field in while", async () => {
	const input = `
import System

struct Item {
    var int value
    var bool done = false
}

func process = (ref Item i) {
    while !i.done {
        Console.write("\\{i.value}")
        i.done = true
    }
}

pub func main = () {
    var Item x = Item(7)
    process(ref x)
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	await check_output("ref_struct_bool", result, "7");
});
