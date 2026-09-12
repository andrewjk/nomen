import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

test("[ .. ctor, overrides ] declaration and factory chaining", async () => {
	const input = `
import System

struct Node {
    var string node_type = ""
    var int index = 0
    var bool is_block = false
    var string content = ""
}

func new_block = (string t, int i) => [ .. Node(), node_type = t, index = i, is_block = true ]

pub func main = () {
    var Node n = [ .. Node(), node_type = "para", index = 7, is_block = true ]
    Console.write("\\{n.node_type} \\{n.index} \\{n.is_block} '\\{n.content}'")
    var Node m = [ .. new_block("text", 3), content = "hi" ]
    Console.write("\\{m.node_type} \\{m.content} \\{m.index} \\{m.is_block}")
}
`;
	await build_and_check_output(input, "base_literal_basic", "para 7 true ''text hi 3 true", true);
});

test("[ .. var, overrides ] across declaration/assignment/return/arg positions", async () => {
	const input = `
import System

struct Pnt {
    var int x = 0
    var int y = 0
}

func show = (Pnt p, out string) => "\\{p.x},\\{p.y}"

func make = (int x, out Pnt) {
    return [ .. Pnt(), x = x, y = 9 ]
}

pub func main = () {
    var Pnt a = [ .. Pnt() ]
    var Pnt b = [ .. a, x = 3 ]
    Console.write(show(a))
    Console.write("\\n")
    Console.write(show(b))
    Console.write("\\n")
    b = [ .. b, y = 4 ]
    Console.write(show(b))
    Console.write("\\n")
    Console.write(show([ .. b, x = 5 ]))
    Console.write("\\n")
    var Pnt r = make(8)
    Console.write(show(r))
    Console.write("\\n")
}
`;
	await build_and_check_output(input, "base_literal_positions", "0,0\n3,0\n3,4\n5,4\n8,9\n", true);
});

test("[ .. move var, overrides ] transfers ownership", async () => {
	const input = `
import System

struct Node {
    var string node_type = ""
    var int index = 0
}

pub func main = () {
    var Node y = [ .. Node(), node_type = "moved", index = 5 ]
    var Node x = [ .. move y, index = 6 ]
    Console.write("\\{x.node_type} \\{x.index}")
}
`;
	await build_and_check_output(input, "base_literal_move", "moved 6", true);
});

test("base literal error cases", () => {
	const base = `
import System

struct Node {
    var string node_type = ""
    var int index = 0
}
`;
	// non-struct base
	let parsed = parse_raw(`${base}
pub func main = () {
    var int i = 5
    var Node n = [ .. i, index = 1 ]
}
`);
	expect(parsed.errors.some((e) => e.message.includes("is not a value struct"))).toBe(true);

	// unknown field
	parsed = parse_raw(`${base}
pub func main = () {
    var Node n = [ .. Node(), nope = 1 ]
}
`);
	expect(parsed.errors.some((e) => e.message.includes("Unknown field 'nope'"))).toBe(true);

	// non-defaulted field
	parsed = parse_raw(`${base}
struct Req {
    var int must
    var int opt = 2
}

pub func main = () {
    var Req r = [ .. Req(1), must = 5 ]
}
`);
	expect(parsed.errors.some((e) => e.message.includes("has no default"))).toBe(true);

	// owning-struct var base without move
	parsed = parse_raw(`${base}
pub func main = () {
    var Node o = [ .. Node() ]
    var Node p = [ .. o ]
}
`);
	expect(parsed.errors.some((e) => e.message.includes("cannot copy 'Node' by value"))).toBe(true);
});
