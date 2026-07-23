import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./ziglings/parse_with_imports";

// Originally used `ref Node?` fields (now disallowed for soundness). Rewritten
// to use the arena LinkedList: a flat buffer of value+next-index slots with a
// single owner, so there is no dangling borrow. -1 plays the role of "null".

test("arena linked list - basic", async () => {
	const input = `
import System

pub func main = () {
    var LinkedList<int> list = LinkedList<int>()
    list.add(1)
    list.add(2)
    if list.count > 0 {
        var int a = list.at(0)
        Console.write("a.value=\\{a} ")
    }
    if list.count > 1 {
        var int b = list.at(1)
        Console.write("b.value=\\{b}\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "nullable_ref_basic", "a.value=1 b.value=2\n", true);
});

test("arena linked list - empty next is -1", async () => {
	const input = `
import System

pub func main = () {
    var LinkedList<int> list = LinkedList<int>()
    list.add(1)
    if list.next_at(0) == -1 {
        Console.write("next is null\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "nullable_ref_null_check", "next is null\n", true);
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
	await build_and_check_output(input, "ref_struct_param", "5", true);
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
	await build_and_check_output(input, "ref_struct_assign", "42", true);
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
	await build_and_check_output(input, "ref_struct_bool", "7", true);
});
