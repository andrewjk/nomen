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

test("override value reading the destination sees pre-assignment state", async () => {
	const input = `
struct Meta {
    var int id
    var int flags = 5
}
var Meta m = Meta(1)
m.flags = 100
var Meta x = Meta(2)
x.flags = 200
m = [ .. x, flags = m.flags ]
Console.write_line(m.id.to_string())
Console.write_line(m.flags.to_string())
`;
	await build_and_check_output(input, "fov_self_read", "2\n100");
});

// Regression: an override that READS THE DESTINATION (`label = m.label`) must
// be evaluated before the base copy lands — the base overwrites the
// destination's bytes, and the post-copy read observed the clobbered value
// ("leaf:none" instead of "leaf:mine"). The value is hoisted into a temp that
// OWNS a copy of the pre-assignment field (the base copy may displace/free
// the old field, so a borrow alias would dangle).
test("[ .. move base, override reading destination ]", async () => {
	const input = `
struct Rec {
	var string kind
	var string label = "none"
	var int flags = 0
}

var Rec m = Rec("branch")
m.label = "mine"
var Rec x = Rec("leaf")
m = [ .. move x, label = m.label ]
Console.write_line("\\{m.kind}:\\{m.label}")
`;
	await build_and_check_output(input, "base_literal_dest_read_string", "leaf:mine\n");
});

// Same clobber hazard for a STRUCT-typed override (a snapshot of the
// destination's pre-assignment field).
test("[ .. move base, struct-typed override reading destination ]", async () => {
	const input = `
struct Inner {
	var int v = 0
}

struct Rec {
	var Inner inner = Inner()
	var int flags = 0
}

var Rec m = Rec()
m.inner.v = 7
var Rec x = Rec()
m = [ .. move x, inner = m.inner ]
Console.write_line("\\{m.inner.v}:\\{m.flags}")
`;
	await build_and_check_output(input, "base_literal_dest_read_struct", "7:0\n");
});

// Regression (C): `m = move x` for a value struct owning heap string fields
// freed the destination's recorded heap fields at the NEXT field write /
// scope exit against the POST-COPY (base's) bytes — an invalid free of rodata
// and a leak of the displaced copy. The recorded fields are now released
// (and their records dropped) before the move copy lands.
test("move reassignment releases displaced heap string fields", async () => {
	const input = `
struct Rec {
	var string kind
	var string label = "none"
	var int flags = 0
}

var Rec m = Rec("branch")
m.label = "mine"
var Rec x = Rec("leaf")
m = move x
Console.write_line("\\{m.kind}:\\{m.label}")
`;
	await build_and_check_output(input, "base_literal_move_reassign", "leaf:none\n");
});

// A collection-typed field default initializes the field in `#init` and
// reclaims it in the auto-destroy (both backends).
test("List-typed field default", async () => {
	const input = `
struct TreeNode {
	var int value = 0
	var List<int> children = List<int>()
}

var TreeNode t = TreeNode()
Console.write_line("\\{t.value}")
t.children.push(5)
Console.write_line("\\{t.children.length}")
`;
	await build_and_check_output(input, "base_literal_list_field_default", "0\n1\n");
});
