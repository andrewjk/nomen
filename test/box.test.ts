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
// shape for owning structs. A Box is one pointer at runtime (the wrapper is
// compiler-generated): `Box<T>?` is the natural null slot, construction
// moves the value in, destroy reclaims the pointee, and access through the
// box is transparent (`box.f` → the pointee's `f`, rewritten at check time).

describe("Box: checker", () => {
	test("an inline containment cycle is rejected, naming the fix", () => {
		const input = `
owning struct Node {
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
owning struct Node {
	var int value
	var Box<Node>? next
}
`;
		expect(check(input)).toEqual([]);
	});

	test("a bare Box binding copy is an error (owning)", () => {
		const input = `
owning struct Node {
	var int value
}
var Node n = Node(1, null)
var Box<Node> h = Box<Node>(move n)
var Box<Node> h2 = h
`;
		const errors = check(input);
		// A class-stamped Box source is ALIASABLE — the precise spelled-alias
		// error wins over the generic box-copy message.
		expect(errors.some((e) => e.message.includes("'h' is aliased"))).toBe(true);
	});

	test("a bare Box param is an error (move or ref)", () => {
		const input = `
owning struct Node {
	var int value
}
func take = (Box<Node> h) {
	Console.write_line("take")
}
`;
		const errors = check(input);
		expect(errors.some((e) => e.message.includes("must be declared `move`"))).toBe(true);
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
owning struct Node {
	var int value
	var Box<Node>? next
}
pub func main = () {
	var Node n = Node(7, null)
	var Box<Node> b = Box<Node>(move n)
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

	test("a boxed chain reads through two levels of transparency", async () => {
		const input = `
import System
owning struct Node {
	var int value
	var Box<Node>? next
}
pub func main = () {
	var Node inner = Node(20, null)
	var Box<Node>? outer_next = Box<Node>(move inner)
	var Node head_node = Node(10, null)
	var Box<Node> head = Box<Node>(move head_node)
	head.__value.next = move outer_next
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
