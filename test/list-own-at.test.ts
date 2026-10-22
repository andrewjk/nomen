import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

const lib = get_library(path.resolve(import.meta.dirname, "../core"));

function errors(src: string) {
	return parse(src, lib).errors.map((e) => `${e.message}`);
}

/**
 * The `List<Own>.at()` owning-copy read (the FOLLOWUP.md entry): a bitwise
 * element load of a heap-owning struct aliases the slot's non-privatizable
 * resources — a `#destroy` over a non-string field (an AppKit-style handle)
 * cannot be cloned, so the binding is a PURE BORROW: its scope-exit destroy
 * is suppressed and the slot's destroy remains the only one. Before the fix,
 * the borrowed copy was destroy-tracked too, so the handle released twice
 * (`7 D D!` shapes below printed the destroy for the local AND the slot).
 */

describe("List<Own>.at() element-load borrows", () => {
	test("a #destroy-over-handle element read destroys exactly once", async () => {
		const input = `
mv struct Res {
	var uint64 handle

	func #destroy = () {
		Console.write("D")
	}
}

var List<Res> items = List<Res>()
items.push(Res(7))
for i of 0 .. items.length {
	var Res r = items.at(i)
	Console.write("\\{r.handle} ")
}
Console.write("!")
`;
		// The slot's destroy fires at main's scope exit — after the "!". A
		// second D before it would be the borrowed local's (the bug).
		await build_and_check_output(input, "list_own_at_handle", "7 !D");
	});

	test("at_or_panic reads destroy exactly once", async () => {
		const input = `
mv struct Res {
	var uint64 handle

	func #destroy = () {
		Console.write("D")
	}
}

var List<Res> items = List<Res>()
items.push(Res(7))
var Res r = items.at_or_panic(0)
Console.write("\\{r.handle}!")
`;
		await build_and_check_output(input, "list_own_at_or_panic_handle", "7!D");
	});

	test("a nested #destroy struct without a copy destroys exactly once", async () => {
		const input = `
mv struct Inner {
	var uint64 handle

	func #destroy = () {
		Console.write("I")
	}
}

mv struct Outer {
	var Inner inner
}

var List<Outer> items = List<Outer>()
items.push(Outer(Inner(7)))
for i of 0 .. items.length {
	var Outer o = items.at(i)
	Console.write("\\{o.inner.handle} ")
}
Console.write("!")
`;
		await build_and_check_output(input, "list_own_at_nested", "7 !I");
	});

	test("holding the read across a container mutation is rejected", () => {
		// The read is a borrow rooted at the container: the ordinary
		// invalidation-on-mutation rule guards it (the residual sharp edge
		// the FOLLOWUP entry names).
		const errs = errors(`
import System

mv struct Res {
	var uint64 handle

	func #destroy = () {
		Console.write("D")
	}
}

pub func main = () {
	var List<Res> items = List<Res>()
	items.push(Res(7))
	var Res r = items.at_or_panic(0)
	items.remove_at_or_panic(0)
	Console.write("\\{r.handle}")
}`);
		expect(errs.some((m) => m.includes("invalidated"))).toBe(true);
	});

	test("moving the read into an mv parameter is rejected", () => {
		const errs = errors(`
import System

mv struct Res {
	var uint64 handle

	func #destroy = () {
		Console.write("D")
	}
}

func take = (mv Res t, out int) {
	return 0
}

pub func main = () {
	var List<Res> items = List<Res>()
	items.push(Res(7))
	var Res r = items.at_or_panic(0)
	var int n = take(mv r)
	Console.write("\\{n}")
}`);
		expect(errs.some((m) => m.includes("borrowed"))).toBe(true);
	});

	test("the borrow survives reads and non-mutating calls", () => {
		const errs = errors(`
import System

mv struct Res {
	var uint64 handle

	func value = (self, out int) {
		return 1
	}
}

pub func main = () {
	var List<Res> items = List<Res>()
	items.push(Res(7))
	var Res r = items.at_or_panic(0)
	var int n = r.value()
	Console.write("\\{r.handle} \\{n}")
}`);
		expect(errs).toEqual([]);
	});
});
