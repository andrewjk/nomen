import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

const system = get_library(path.resolve("core"));

function check(source: string) {
	return parse(`import System\n${source}`, system, undefined, { allow_internal: true }).errors;
}

// STRUCT_PLAN_3 Phase B B2 — Box<T>: the cycle-breaking, stable-address
// shape for mv structs. A Box is one pointer at runtime (the wrapper is
// compiler-generated): `Box<T>?` is the natural null slot, construction
// moves the value in, destroy reclaims the pointee, and access through the
// box is transparent (`box.f` → the pointee's `f`, rewritten at check time).

describe("Box: checker", () => {
	test("an inline containment cycle is rejected, naming the fix", () => {
		const input = `
mv struct Node {
	var int value
	var Node next
}
`;
		const errors = check(input);
		expect(
			errors.some(
				(e) =>
					e.message.includes("closes an inline containment cycle") &&
					e.message.includes("`Box<Node>`"),
			),
		).toBe(true);
	});

	test("a Box field breaks the cycle (accepted)", () => {
		const input = `
mv struct Node {
	var int value
	var Box<Node>? next
}
`;
		expect(check(input)).toEqual([]);
	});

	test("a bare Box binding copy is an error (mv)", () => {
		const input = `
mv struct Node {
	var int value
}
var Node n = Node(1, null)
var Box<Node> h = Box<Node>(mv n)
var Box<Node> h2 = h
`;
		const errors = check(input);
		// A class-stamped Box source is ALIASABLE — the precise spelled-alias
		// error wins over the generic box-copy message.
		expect(errors.some((e) => e.message.includes("'h' is aliased"))).toBe(true);
	});

	test("a bare Box param is an error (mv or ref)", () => {
		const input = `
mv struct Node {
	var int value
}
func take = (Box<Node> h) {
	Console.write_line("take")
}
`;
		const errors = check(input);
		expect(errors.some((e) => e.message.includes("must be declared `mv`"))).toBe(true);
	});

	test("a Box field in a bare struct triggers the Copyable verifier", () => {
		const input = `
struct Wrapper {
	var Box<Wrapper>? child
}
`;
		expect(check(input).some((e) => e.message.includes("'Wrapper' cannot be Copyable"))).toBe(true);
	});
});

describe("Box: runtime (both backends)", () => {
	test("construction, transparent read, and teardown are audit-clean", async () => {
		const input = `
import System
mv struct Node {
	var int value
	var Box<Node>? next
}
pub func main = () {
	var Node n = Node(7, null)
	var Box<Node> b = Box<Node>(mv n)
	Console.write_line("\\{b.value}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		for (const arch of ["c", "aarch64"] as const) {
			const built = build(parsed.root, { arch, audit: true });
			await check_output("box_basic_" + arch, built, "7\n", { arch, audit: true });
		}
	});

	test("a nullable box returned from an accessor reads through transparently", async () => {
		const input = `
import System
mv struct Node {
	var int value
}
mv struct Store {
	var List<Box<Node>> items = List<Box<Node>>()
	func add = (ref self, mv Box<Node> n) {
		self.items.push(mv n)
	}
	func get = (ref self, int i, out Box<Node>?) {
		if i < self.items.length {
			return self.items.at_or_panic(i)
		}
		return null
	}
}
pub func main = () {
	var Store s = Store()
	var Node a = Node(7)
	s.add(Box<Node>(mv a))
	var Node b = Node(9)
	s.add(Box<Node>(mv b))
	Console.write_line("\\{s.get(1).value}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		for (const arch of ["c", "aarch64"] as const) {
			const built = build(parsed.root, { arch, audit: true });
			await check_output("box_call_result_" + arch, built, "9\n", { arch, audit: true });
		}
	});

	test("a boxed chain reads through two levels of transparency", async () => {
		const input = `
import System
mv struct Node {
	var int value
	var Box<Node>? next
}
pub func main = () {
	var Node inner = Node(20, null)
	var Box<Node>? outer_next = Box<Node>(mv inner)
	var Node head_node = Node(10, null)
	var Box<Node> head = Box<Node>(mv head_node)
	head.__value.next = mv outer_next
	Console.write_line("\\{head.value}")
	Console.write_line("\\{head.next.value}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		for (const arch of ["c", "aarch64"] as const) {
			const built = build(parsed.root, { arch, audit: true });
			await check_output("box_chain_" + arch, built, "10\n20\n", { arch, audit: true });
		}
	});
});

// STRUCT_PLAN_3 Box elision: `Box<T>(T(...))` — a direct constructor of the
// wrapped type — builds the value DIRECTLY into the freshly malloc'd box
// slot. The intermediate stack temp (`_param_N`) and the `<Box>_init` memcpy
// of it disappear; the named-donor move (`Box<T>(mv n)`) keeps its byte-wise
// move. The elided temp never exists, so the destroyed-donor rules are
// trivially satisfied, and the wrapped struct's string seeds are uniformly
// heap IN the slot (the box's destroy reclaims them exactly once).
describe("Box: construct-in-place elision", () => {
	test("a direct-constructor argument runs audit-clean on both backends", async () => {
		const input = `
import System
mv struct Wrap {
	var string name
	var int value
}
pub func main = () {
	var Box<Wrap> b = Box<Wrap>(Wrap("hi", 7))
	Console.write_line("\\{b.name} \\{b.value}")
	var Box<Wrap> c = Box<Wrap>(mv Wrap("yo", 9))
	Console.write_line("\\{c.name} \\{c.value}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		for (const arch of ["c", "aarch64"] as const) {
			const built = build(parsed.root, { arch, audit: true });
			await check_output("box_in_place_" + arch, built, "hi 7\nyo 9\n", { arch, audit: true });
		}
	});

	test("a direct-constructor tree shape runs audit-clean on both backends", async () => {
		const input = `
import System
mv struct Node {
	var int value
	var Box<Node>? next
}
pub func main = () {
	var Node n = Node(1, null)
	var Box<Node> head = Box<Node>(mv n)
	head.next = Box<Node>(Node(2, null))
	Console.write_line("\\{head.next.value}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		for (const arch of ["c", "aarch64"] as const) {
			const built = build(parsed.root, { arch, audit: true });
			await check_output("box_in_place_tree_" + arch, built, "2\n", { arch, audit: true });
		}
	});

	test("the C backend constructs straight into the box slot", () => {
		const input = `
import System
mv struct Node {
	var int value
	var Box<Node>? next
}
pub func main = () {
	var Node n = Node(1, null)
	var Box<Node> head = Box<Node>(mv n)
	head.next = Box<Node>(Node(2, null))
	Console.write_line("\\{head.next.value}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const built = build(parsed.root, { arch: "c" });
		// The direct-ctor argument lowers to a statement expression that
		// constructs the wrapped value INTO the box slot — no hoisted
		// `_param_N` stack temp, no `<Box>_init` call for that argument.
		expect(built.code).toContain("_box->__value = Node_init(");
		expect(built.code).not.toMatch(/struct Node _param_\d+ = Node_init\(/);
		// The named-donor move keeps its byte-wise `_init` copy.
		expect(built.code).toContain("Box_Node_init((void *)&n)");
	});

	test("the aarch64 backend constructs straight into the box slot", () => {
		const input = `
import System
mv struct Node {
	var int value
	var Box<Node>? next
}
pub func main = () {
	var Node n = Node(1, null)
	var Box<Node> head = Box<Node>(mv n)
	head.next = Box<Node>(Node(2, null))
	Console.write_line("\\{head.next.value}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const built = build(parsed.root, { arch: "aarch64" });
		// Exactly ONE `Box_Node_init` call remains — the named donor's
		// byte-wise move; the direct-ctor construction no longer routes
		// through the wrapper's copy constructor.
		const box_inits = built.code.match(/bl Box_Node_init\b/g) ?? [];
		expect(box_inits.length).toBe(1);
		// The elided temp's hoisted declaration is gone (the direct ctor runs
		// inside the assignment statement, not as a separate allocation).
		expect(built.code).not.toMatch(/_param_\d+:\n/);
	});
});
