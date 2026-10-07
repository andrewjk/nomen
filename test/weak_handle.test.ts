import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

// STRUCT_PLAN_3 Phase N N3 — WeakHandle<T>: a checked, generation-validated
// handle to a possibly-gone object. The registry is one process-wide
// (pointer, generation) slot table; the tracked type's `#destroy`
// invalidates every slot holding the pointer; `get` compares and returns
// NULL on mismatch. The handle owns NOTHING — the tracked instance must be
// owned elsewhere (a fresh temporary is rejected), and a handle binds once
// at its declaration (the creation is the marker).

const system = get_library(path.resolve("core"));

function check(source: string) {
	return parse(source, system, undefined, { allow_internal: true }).errors;
}

const widget = `
owning struct Cell {
	var int id
	func #destroy = (ref self) {
		Console.write_line("destroying")
	}
}
`;

// WeakHandle tracks a BOXED instance (`WeakHandle<Box<Cell>>`): the box is
// the stable-address heap handle, so the registry's (pointer, generation)
// slot has a sound subject. Tracking an inline owning struct's storage (the
// N3 value-T lowering) is future work — see FOLLOWUP.md.

describe("WeakHandle: runtime", () => {
	test("a live handle reads the instance (both backends)", async () => {
		const input = `
import System
${widget}
pub func main = () {
	var Box<Cell> a = Box<Cell>(Cell(5))
	var WeakHandle<Box<Cell>> h = WeakHandle<Box<Cell>>(a)
	var Box<Cell>? live = h.get()
	if live != null {
		Console.write_line("alive")
	} else {
		Console.write_line("gone")
	}
}
`;
		await build_and_check_output(input, "weak_handle_alive", "alive\n", true);
	});

	test("a handle stored in the tracked object's owner invalidates on reassignment (aarch64 eager free)", async () => {
		const input = `
import System
${widget}
pub func main = () {
	var Box<Cell> a = Box<Cell>(Cell(5))
	var WeakHandle<Box<Cell>> h = WeakHandle<Box<Cell>>(a)
	var Box<Cell>? now = h.get()
	if now != null {
		Console.write_line("alive")
	}
	a = Box<Cell>(Cell(9))
	var Box<Cell>? after = h.get()
	if after != null {
		Console.write_line("stale")
	} else {
		Console.write_line("gone")
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const built = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output(
			"weak_handle_invalidate_a64",
			built,
			"alive\ndestroying\ngone\ndestroying\n",
			{
				arch: "aarch64",
				audit: true,
			},
		);
	});

	test("the C backend defers the displaced instance's free (lenient class frees), so the handle reads live until scope exit", async () => {
		const input = `
import System
${widget}
pub func main = () {
	var Box<Cell> a = Box<Cell>(Cell(5))
	var WeakHandle<Box<Cell>> h = WeakHandle<Box<Cell>>(a)
	var Box<Cell>? now = h.get()
	if now != null {
		Console.write_line("alive")
	}
	a = Box<Cell>(Cell(9))
	var Box<Cell>? after = h.get()
	if after != null {
		Console.write_line("deferred")
	} else {
		Console.write_line("gone")
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const built = build(parsed.root, { arch: "c", audit: true });
		await check_output("weak_handle_deferred_c", built, "alive\ndeferred\n", {
			arch: "c",
			audit: true,
		});
	});

	test("a handle in a child→parent field shape reads through the registry", async () => {
		const input = `
import System
${widget}
owning struct Parent {
	var int marker
}
pub func main = () {
	var Box<Cell> child = Box<Cell>(Cell(2))
	var Parent p = Parent(7)
	var WeakHandle<Box<Cell>> h = WeakHandle<Box<Cell>>(child)
	var Box<Cell>? live = h.get()
	if live != null {
		Console.write_line("\\{p.marker}")
	}
}
`;
		await build_and_check_output(input, "weak_handle_field_shape", "7\n", true);
	});
});

describe("WeakHandle: errors", () => {
	test("a fresh temporary has no owner and is rejected", () => {
		const input = `
import System
${widget}
var WeakHandle<Box<Cell>> h = WeakHandle<Box<Cell>>(Box<Cell>(Cell(5)))
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("bind it to a variable first"))).toBe(true);
	});

	test("a non-class tracked type is rejected", () => {
		const input = `
import System
struct P {
	var int x
}
var P p = P(1)
var WeakHandle<P> h = WeakHandle<P>(p)
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("tracks a class instance"))).toBe(true);
	});

	test("a handle is not re-pointed (binds once at the declaration)", () => {
		const input = `
import System
${widget}
var Box<Cell> a = Box<Cell>(Cell(5))
var WeakHandle<Box<Cell>> h = WeakHandle<Box<Cell>>(a)
h = WeakHandle<Box<Cell>>(a)
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("a handle is not re-pointed"))).toBe(true);
	});

	test("the construction expects exactly one argument", () => {
		const input = `
import System
${widget}
var Box<Cell> a = Box<Cell>(Cell(5))
var WeakHandle<Box<Cell>> h = WeakHandle<Box<Cell>>(a, a)
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("exactly one argument"))).toBe(true);
	});
});
