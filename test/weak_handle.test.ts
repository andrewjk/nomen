import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";
import test_error from "./test_error";

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
class Widget {
	var int id
	func #destroy = (ref self) {
		Console.write_line("destroying")
	}
}
`;

describe("WeakHandle: runtime", () => {
	test("a live handle reads the instance (both backends)", async () => {
		const input = `
import System
${widget}
pub func main = () {
	var Widget a = Widget(5)
	var WeakHandle<Widget> h = WeakHandle<Widget>(a)
	var Widget? live = h.get()
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
	var Widget a = Widget(5)
	var WeakHandle<Widget> h = WeakHandle<Widget>(a)
	var Widget? now = h.get()
	if now != null {
		Console.write_line("alive")
	}
	a = Widget(9)
	var Widget? after = h.get()
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
	var Widget a = Widget(5)
	var WeakHandle<Widget> h = WeakHandle<Widget>(a)
	var Widget? now = h.get()
	if now != null {
		Console.write_line("alive")
	}
	a = Widget(9)
	var Widget? after = h.get()
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
class Parent {
	var int marker
}
pub func main = () {
	var Widget child = Widget(2)
	var Parent p = Parent(7)
	var WeakHandle<Widget> h = WeakHandle<Widget>(child)
	var Widget? live = h.get()
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
var WeakHandle<Widget> h = WeakHandle<Widget>(Widget(5))
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
var Widget a = Widget(5)
var WeakHandle<Widget> h = WeakHandle<Widget>(a)
h = WeakHandle<Widget>(a)
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("a handle is not re-pointed"))).toBe(true);
	});

	test("the construction expects exactly one argument", () => {
		const input = `
import System
${widget}
var Widget a = Widget(5)
var WeakHandle<Widget> h = WeakHandle<Widget>(a, a)
`;
		const messages = check(input).map((e) => e.message);
		expect(messages.some((m) => m.includes("exactly one argument"))).toBe(true);
	});
});
