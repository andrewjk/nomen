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
 * `StableList<T>` — the grow-only list whose element borrows SURVIVE `push`
 * (docs/GOOSE.md, "Stable grow-only arrays"). The list is append-only (no
 * `pop`/`set`/`remove_at`/`slot_ptr`), so growth reallocs the slot array but
 * displaces no element resources: a borrow from `.at` holds the slot's bytes
 * (value tier) or an instance pointer (class tier), and the checker exempts
 * `push` from borrow invalidation for this type only.
 */

describe("StableList basics", () => {
	test("push, at under a loop range, length", async () => {
		const input = `
var StableList<int> xs = StableList<int>()
xs.push(10)
xs.push(20)
xs.push(30)
var int sum = 0
for i of 0 .. xs.length {
	sum = sum + xs.at(i)
}
Console.write("\\{sum} \\{xs.length}")
`;
		await build_and_check_output(input, "stable_list_ints", "60 3");
	});

	test("string elements survive growth and iterate", async () => {
		const input = `
var StableList<string> names = StableList<string>()
var int i = 0
while i < 40; i += 1 {
	names.push("xy")
}
var string first = names.at_or_panic(0)
var int total = 0
for s of names {
	total = total + s.length
}
Console.write("\\{first} \\{total} \\{names.length}")
`;
		await build_and_check_output(input, "stable_list_strings", "xy 80 40");
	});

	test("copy is independent of the source", async () => {
		const input = `
var StableList<int> a = StableList<int>()
a.push(1)
a.push(2)
var StableList<int> b = a.copy()
b.push(3)
Console.write("\\{a.length} \\{b.length}")
`;
		await build_and_check_output(input, "stable_list_copy", "2 3");
	});
});

describe("StableList borrows survive push", () => {
	test("a #destroy-over-handle element read survives 40 pushes, destroyed once", async () => {
		const input = `
mv struct Res {
	var uint64 handle

	func #destroy = () {
		Console.write("D")
	}
}

var StableList<Res> items = StableList<Res>()
items.push(Res(7))
var Res r = items.at_or_panic(0)
var int k = 0
while k < 40; k += 1 {
	items.push(Res(k + 1))
}
Console.write("\\{r.handle}!")
`;
		// The read is a pure borrow (the slot keeps sole ownership). Growth
		// reallocs the slot array mid-loop; the borrow holds the slot's bytes,
		// so it stays valid. At scope exit the list destroys every slot once —
		// 41 D's, and none for `r` itself.
		await build_and_check_output(input, "stable_list_own_survives_push", "7!" + "D".repeat(41));
	});

	test("a Box element mutated through a borrow keeps the mutation after pushes", async () => {
		const input = `
mv struct Widget {
	var int weight = 0
}

var StableList<Box<Widget>> ws = StableList<Box<Widget>>()
ws.push(Box<Widget>(Widget()))
var Box<Widget> first = ws.at_or_panic(0)
var int i = 1
while i < 100; i += 1 {
	ws.push(Box<Widget>(Widget()))
}
first.weight = 99
Console.write("\\{first.weight}!")
`;
		// The Goose demo shape: the borrow holds the heap instance's pointer,
		// so the write lands in the instance even after 99 pushes.
		await build_and_check_output(input, "stable_list_box_mutate_after_pushes", "99!");
	});

	test("push while an element borrow is live checks clean", () => {
		const errs = errors(`
import System

mv struct Res {
	var uint64 handle

	func #destroy = () {
		Console.write("D")
	}
}

pub func main = () {
	var StableList<Res> items = StableList<Res>()
	items.push(Res(7))
	var Res r = items.at_or_panic(0)
	var int k = 0
	while k < 40; k += 1 {
		items.push(Res(k))
	}
	Console.write("\\{r.handle}")
}`);
		expect(errs).toEqual([]);
	});
});

describe("StableList v2 — chunked storage, interior addresses", () => {
	test("a slot alias (ref T x = sl.at(i)) survives pushes and writes through", async () => {
		const input = `
mv struct Cell {
	var int value
}

var StableList<Cell> cells = StableList<Cell>()
cells.push(Cell(1))
if cells.length > 0 {
	ref Cell c = cells.at(0)
	var int k = 0
	while k < 40; k += 1 {
		cells.push(Cell(k))
	}
	c.value = 99
}
Console.write("\\{cells.at_or_panic(0).value}!")
`;
		// The interior-address borrow: `ref Cell c` binds the SLOT itself,
		// the push exemption keeps it alive across 40 pushes, and the write
		// lands in the list (the slot address never moves).
		await build_and_check_output(input, "stable_list_slot_alias_write", "99!");
	});

	test("300 elements across a chunk boundary destroy exactly once", async () => {
		const input = `
mv struct Res {
	var uint64 handle

	func #destroy = () {
		Console.write("D")
	}
}

var StableList<Res> items = StableList<Res>()
items.push(Res(7))
var Res r = items.at_or_panic(0)
var int k = 0
while k < 299; k += 1 {
	items.push(Res(k + 1))
}
Console.write("\\{r.handle}!")
`;
		// 300 elements = chunk 0 (256) + one directory chunk (44 filled).
		// Chunk 0 is reclaimed by the field destroy (constructed-slot guard),
		// the directory chunk through the cap=filled view — every element
		// destroyed exactly once, no uninitialized-slot walks.
		await build_and_check_output(input, "stable_list_multichunk_destroy", "7!" + "D".repeat(300));
	});

	test("strings across a chunk boundary iterate and read", async () => {
		const input = `
var StableList<string> names = StableList<string>()
var int i = 0
while i < 300; i += 1 {
	names.push("xy")
}
var string first = names.at_or_panic(0)
var int total = 0
for s of names {
	total = total + s.length
}
Console.write("\\{first} \\{total} \\{names.length}")
`;
		await build_and_check_output(input, "stable_list_strings_300", "xy 600 300");
	});
});

describe("StableList borrow rules that still apply", () => {
	test("plain List.push still invalidates element borrows (exemption is type-scoped)", () => {
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
	items.push(Res(1))
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
	var StableList<Res> items = StableList<Res>()
	items.push(Res(7))
	var Res r = items.at_or_panic(0)
	var int n = take(mv r)
	Console.write("\\{n}")
}`);
		expect(errs.some((m) => m.includes("borrowed"))).toBe(true);
	});

	test("a borrow cannot escape by being returned", () => {
		const errs = errors(`
import System

mv struct Res {
	var uint64 handle

	func #destroy = () {
		Console.write("D")
	}
}

func steal = (ref StableList<Res> items, out Res) {
	var Res r = items.at_or_panic(0)
	return r
}

pub func main = () {
	var StableList<Res> items = StableList<Res>()
	items.push(Res(7))
	var Res stolen = steal(ref items)
	Console.write("\\{stolen.handle}")
}`);
		expect(errs.some((m) => m.includes("cannot return a borrowed"))).toBe(true);
	});

	test("the interior-address form (ref T x = sl.at(i)) is a compile error — StableList opts out of slot_ptr", () => {
		// The `ref T x = container.at(i)` rewrite to `slot_ptr` only fires
		// when the container exposes the primitive (element_slot_load:
		// "ad-hoc structs with an `at` method don't opt in"). StableList
		// deliberately omits slot_ptr — an interior slot ADDRESS would not
		// survive growth's realloc — so the form falls to the ref-binding
		// enforcement and is rejected outright rather than aliasing a slot.
		const errs = errors(`
import System

mv struct Res {
	var uint64 handle
}

pub func main = () {
	var StableList<Res> items = StableList<Res>()
	items.push(Res(7))
	ref Res r = items.at_or_panic(0)
	Console.write("\\{r.handle}")
}`);
		expect(errs.some((m) => m.includes("'ref' binds an alias"))).toBe(true);
	});

	test("'ref' iteration is rejected, naming StableList", () => {
		const errs = errors(`
import System

pub func main = () {
	var StableList<int> xs = StableList<int>()
	xs.push(1)
	for ref x of xs {
		Console.write("\\{x}")
	}
}`);
		expect(errs.some((m) => m.includes("'ref' iteration is not supported for StableList<T>"))).toBe(
			true,
		);
	});
});
