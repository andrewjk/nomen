import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
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
// box is transparent (`box.f` → `box.value.f`, rewritten at check time).
// NOTE: the aarch64 runtime shape is gated to C — BUGS.md #10 (a generic
// class with an inline value-struct T field sizes T as one word).

describe("Box: checker", () => {
	test("an inline containment cycle is rejected, naming the fix", () => {
		const input = `
owning struct Node {
	var int value
	var Node next
}
`;
		const parsed = check(input);
		expect(
			parsed.some(
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

	test("a Box field in a bare struct triggers the Copyable verifier", () => {
		const input = `
struct Wrapper {
	var Box<Wrapper>? child
}
`;
		expect(check(input).some((e) => e.message.includes("'Wrapper' cannot be Copyable"))).toBe(true);
	});

	test("the wrapper's `value` field is not reachable through the box", () => {
		const input = `
owning struct Node {
	var int value
}
var Node n = Node(1)
var Box<Node> b = Box<Node>(move n)
var int v = b.value
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});

describe("Box: runtime (C backend — BUGS.md #10 gates aarch64)", () => {
	test("construction, transparent read, and teardown are audit-clean", () => {
		const input = `
import System
owning struct Node {
	var int value
	var Box<Node>? next
}
func probe = () {
	var Node n = Node(7, null)
	var Box<Node> b = Box<Node>(move n)
	Console.write_line("\\{b.value}")
}
probe()
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const built = build(parsed.root, { arch: "c", audit: true });
		void check_output("box_basic_c", built, "7\n", { arch: "c", audit: true });
	});

	test("a boxed chain reads through two levels of transparency", () => {
		const input = `
import System
owning struct Node {
	var int value
	var Box<Node>? next
}
func probe = () {
	var Node inner = Node(20, null)
	var Box<Node>? outer_next = Box<Node>(move inner)
	var Node head_node = Node(10, outer_next)
	var Box<Node> head = Box<Node>(move head_node)
	Console.write_line("\\{head.value}")
	Console.write_line("\\{head.next.value}")
}
probe()
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const built = build(parsed.root, { arch: "c", audit: true });
		void check_output("box_chain_c", built, "10\n20\n", { arch: "c", audit: true });
	});
});
