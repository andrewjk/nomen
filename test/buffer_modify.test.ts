import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Buffer.modify_T / ClassBuffer.modify_T: the encoded load→modify→store
// round-trip. The primitive applies a `func (T, out T)` to a live slot and
// handles ownership itself (displaced value freed, round-trip identity kept)
// — unlike store_T, which assumes a fresh slot and leaks on overwrite.

test("Buffer.modify_T int element", async () => {
	const input = `
var Buffer<int> b = Buffer<int>()
b.alloc_T(2)
b.store_T(0, 1)
var func (int, out int) add10 = (x, out int) => x + 10
b.modify_T(0, add10)
Console.write("\\{b.load_T(0)}")
`;
	await build_and_check_output(input, "buffer_modify_int", "11");
});

test("Buffer.modify_T string element (fresh + round-trip identity)", async () => {
	const input = `
var Buffer<string> b = Buffer<string>()
b.alloc_T(2)
b.store_T(0, "a")
var func (string, out string) bang = (s, out string) => s + "!"
b.modify_T(0, bang)
Console.write("\\{b.load_T(0)}")
// round-trip: fn returns the slot's own string — kept, not freed or re-copied
var func (string, out string) keep = (s, out string) => s
b.modify_T(0, keep)
Console.write("\\{b.load_T(0)}")
`;
	await build_and_check_output(input, "buffer_modify_string", "a!a!");
});

test("Buffer.modify_T owning struct element", async () => {
	const input = `
struct Named {
	var string name
	var int hits
}

var Buffer<Named> b = Buffer<Named>()
b.alloc_T(2)
b.store_T(0, Named("x", 1))
// Rebuilds the struct: 'name' aliases the slot's own copy (round-trip
// identity — kept), 'hits' is a plain copy. No leak, no double free.
var func (Named, out Named) touch = (n, out Named) {
	return Named(n.name, n.hits + 1)
}
b.modify_T(0, touch)
b.modify_T(0, touch)
Console.write("\\{b.load_T(0).name}:\\{b.load_T(0).hits}")
`;
	await build_and_check_output(input, "buffer_modify_struct", "x:3");
});

test("Buffer.modify_T trivial struct element", async () => {
	const input = `
struct Pair {
	var int a
	var int b
}

var Buffer<Pair> b = Buffer<Pair>()
b.alloc_T(2)
b.store_T(0, Pair(1, 2))
var func (Pair, out Pair) swap_or_add = (p, out Pair) {
	return Pair(p.a + 10, p.b)
}
b.modify_T(0, swap_or_add)
var Pair p = b.load_T(0)
Console.write("\\{p.a}:\\{p.b}")
`;
	await build_and_check_output(input, "buffer_modify_trivial_struct", "11:2");
});

test("ClassBuffer.modify_T class element", async () => {
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
		cb.store_T(0, seed)
		cb.modify_T(0, make_bumped)
		cb.modify_T(0, make_bumped)
		Console.write("\\{cb.load_T(0).value}")
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
