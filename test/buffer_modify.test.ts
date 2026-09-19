import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Buffer.modify / ClassBuffer.modify: the encoded load→modify→store
// round-trip. The primitive applies a `func (T, out T)` to a live slot and
// handles ownership itself (displaced value freed, round-trip identity kept)
// — unlike store, which assumes a fresh slot and leaks on overwrite.

test("Buffer.modify int element", async () => {
	const input = `
var Buffer<int> b = Buffer<int>()
b.alloc(2)
b.store(0, 1)
var func (int, out int) add10 = (x, out int) => x + 10
b.modify(0, add10)
Console.write("\\{b.load(0)}")
`;
	await build_and_check_output(input, "buffer_modify_int", "11");
});

test("Buffer.modify string element (fresh + round-trip identity)", async () => {
	const input = `
var Buffer<string> b = Buffer<string>()
b.alloc(2)
b.store(0, "a")
var func (string, out string) bang = (s, out string) => s + "!"
b.modify(0, bang)
Console.write("\\{b.load(0)}")
// round-trip: fn returns the slot's own string — kept, not freed or re-copied
var func (string, out string) keep = (s, out string) => s
b.modify(0, keep)
Console.write("\\{b.load(0)}")
`;
	await build_and_check_output(input, "buffer_modify_string", "a!a!");
});

test("Buffer.modify owning struct element", async () => {
	const input = `
struct Named {
	var string name
	var int hits
}

var Buffer<Named> b = Buffer<Named>()
b.alloc(2)
b.store(0, Named("x", 1))
// Rebuilds the struct: 'name' aliases the slot's own copy (round-trip
// identity — kept), 'hits' is a plain copy. No leak, no double free.
var func (Named, out Named) touch = (n, out Named) {
	return Named(n.name, n.hits + 1)
}
b.modify(0, touch)
b.modify(0, touch)
Console.write("\\{b.load(0).name}:\\{b.load(0).hits}")
`;
	await build_and_check_output(input, "buffer_modify_struct", "x:3");
});

test("Buffer.modify trivial struct element", async () => {
	const input = `
struct Pair {
	var int a
	var int b
}

var Buffer<Pair> b = Buffer<Pair>()
b.alloc(2)
b.store(0, Pair(1, 2))
var func (Pair, out Pair) swap_or_add = (p, out Pair) {
	return Pair(p.a + 10, p.b)
}
b.modify(0, swap_or_add)
var Pair p = b.load(0)
Console.write("\\{p.a}:\\{p.b}")
`;
	await build_and_check_output(input, "buffer_modify_trivial_struct", "11:2");
});

test("ClassBuffer.modify class element", async () => {
	const input = `
class Counter {
	var int value
}

func make_bumped = (Counter c, out Counter) {
	var Counter fresh = Counter(c.value + 1)
	return fresh
}

struct Buffer_driver {
	func drive = (ref self, move Counter seed, out int) {
		var ClassBuffer<Counter> cb = ClassBuffer<Counter>()
		cb.alloc_int(2)
		cb.store(0, move seed)
		cb.modify(0, make_bumped)
		cb.modify(0, make_bumped)
		Console.write("\\{cb.load(0).value}")
		return 0
	}
}

var Buffer_driver d = Buffer_driver()
d.drive(Counter(1))
Console.write_line("")
`;
	await build_and_check_output(input, "classbuffer_modify_class", "3\n");
});

// Regression: a generic struct method taking `func (T, out T)` must
// substitute T through the nested function signature at monomorphization
// (checker + both backends' emission).
test("generic struct method with func (T, out T) param", async () => {
	const input = `
struct Box<T> {
	var T value

	func modify = (ref self, func (T, out T) f) {
		self.value = f(self.value)
	}
}

var Box<int> bi = Box<int>(1)
var func (int, out int) add10 = (x, out int) => x + 10
bi.modify(add10)
bi.modify(add10)
Console.write("\\{bi.value}")
`;
	await build_and_check_output(input, "generic_func_param", "21");
});

// Regression: a fresh constructor result passed straight into the container
// transfers ownership at the store — `store`/`replace` take `move T`, so
// the hoisted instance temp is consumed and its scope-exit destroy+free is
// suppressed (it used to run alongside the container's per-slot destroy —
// `Counter_destroy` twice on one pointer, SIGABRT).
test("ctor result straight into ClassBuffer.store", async () => {
	const input = `
class Counter {
	var int value
}

struct Buffer_driver {
	func drive = (ref self, out int) {
		var ClassBuffer<Counter> cb = ClassBuffer<Counter>()
		cb.alloc_int(2)
		cb.store(0, Counter(1))
		cb.modify(0, make_bumped)
		Console.write("\\{cb.load(0).value}")
		return 0
	}
}

func make_bumped = (Counter c, out Counter) {
	var Counter fresh = Counter(c.value + 1)
	return fresh
}

var Buffer_driver d = Buffer_driver()
d.drive()
Console.write_line("")
`;
	await build_and_check_output(input, "classbuffer_store_ctor", "2\n");
});

// A class local loaded from a container aliases the slot (a borrow — the
// container still owns the element): the local must NOT be destroy-tracked,
// and storing it back with `move` must not double-free.
test("ClassBuffer slot borrow kept alive across move", async () => {
	const input = `
class Counter {
	var int value
}

struct Buffer_driver {
	func drive = (ref self, move Counter seed, out int) {
		var ClassBuffer<Counter> cb = ClassBuffer<Counter>()
		cb.alloc_int(2)
		cb.store(0, move seed)
		var Counter c = cb.load(0)
		Console.write("\\{c.value}")
		var Counter taken = cb.move(0)
		Console.write("\\{taken.value}")
		return 0
	}
}

var Buffer_driver d = Buffer_driver()
d.drive(Counter(1))
Console.write_line("")
`;
	await build_and_check_output(input, "classbuffer_load_borrow", "11\n");
});

// Regression (aarch64): the auto-init strdup for a class's always-heap string
// field clobbered every still-live incoming arg register — a ctor like
// `Named("alice", 1)` stored garbage in the fields AFTER the string.
test("ctor scalar args survive a preceding string field (aarch64)", async () => {
	const input = `
class Named {
	var string name
	var int value
}

var Named n = Named("alice", 1)
Console.write_line("\\{n.value}")
Console.write_line("\\{n.name}")
`;
	await build_and_check_output(input, "ctor_string_then_scalar", "1\nalice\n");
});

// Regression (aarch64): the ctor call site computed its overflow-arg count
// from the PARAM count, not the SLOT count — a fat-string arg consumes two
// slots, so `Big(name, a..g)` dropped every overflow arg after the first.
test("ctor overflow args after a string field (aarch64)", async () => {
	const input = `
class Big {
	var string name
	var int a
	var int b
	var int c
	var int d
	var int e
	var int f
	var int g
}

var Big r = Big("n", 1, 2, 3, 4, 5, 6, 7)
var string s = r.name + " " + r.a.to_string() + r.b.to_string() + r.c.to_string()
	+ r.d.to_string() + r.e.to_string() + r.f.to_string() + r.g.to_string()
Console.write_line(s)
`;
	await build_and_check_output(input, "ctor_string_overflow_args", "n 1234567\n");
});
