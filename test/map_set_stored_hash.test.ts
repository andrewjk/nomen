import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// PERF_PLAN item 9: Map/Set stored hash. Each slot carries its key's hash
// (truncated to u32) in a parallel buffer; probes short-circuit the key
// compare on a hash mismatch, rehash re-inserts hash-free (no self.set/add
// call), and remove's backward shift moves the hash word with the entry.
// These tests pin the observable contract through the growth, collision,
// and copy paths on both backends (audit on — the rehash/copy move paths
// must not leak or double-free mv elements).

test("Map<string, int> survives rehash growth with all entries intact", async () => {
	const input = `
var Map<string, int> m = Map<string, int>()
var i = 0
while i < 500 {
	m.set("k\\{i}", i * 7)
	i += 1
}
var int sum = 0
i = 0
while i < 500; i += 1 {
	sum += m.get_or("k\\{i}", -1)
}
Console.write("\\{m.length} \\{sum}")
`;
	// sum of i*7 for i in [0, 500) = 7 * 124750
	await build_and_check_output(input, "map_stored_hash_rehash_growth", "500 873250");
});

test("Map remove backward-shift moves the stored hash (colliding cluster)", async () => {
	const input = `
// Keys 0, 8, 16, 24 all home to slot 0 at cap 8 — one cluster. Removing 8
// shifts 16 and 24 backward; their stored hash words must move with them,
// or the hash short-circuit would skip their slots on lookup.
var Map<int, int> m = Map<int, int>()
m.set(0, 100)
m.set(8, 800)
m.set(16, 1600)
m.set(24, 2400)
m.remove(8)
Console.write("\\{m.length} \\{m.get_or(16, -1)} \\{m.get_or(24, -1)} \\{m.get_or(0, -1)} \\{m.get_or(8, -1)}")
`;
	await build_and_check_output(input, "map_stored_hash_shift", "3 1600 2400 100 -1");
});

test("Map negative int keys round-trip u32 hash truncation across rehash", async () => {
	const input = `
// hash(-8k) truncates to 0xFFFF... with home slot 7 at cap 8 — all four
// keys collide at the same home, and rehash must re-home them from the
// stored (truncated) words.
var Map<int, int> m = Map<int, int>()
m.set(-1, 1)
m.set(-9, 9)
m.set(-17, 17)
m.set(-25, 25)
m.set(-33, 33)
Console.write("\\{m.length} \\{m.get_or(-1, 0)} \\{m.get_or(-9, 0)} \\{m.get_or(-17, 0)} \\{m.get_or(-25, 0)} \\{m.get_or(-33, 0)}")
`;
	await build_and_check_output(input, "map_stored_hash_negative_keys", "5 1 9 17 25 33");
});

test("Map set same key twice keeps one entry with the new value", async () => {
	const input = `
var Map<string, int> m = Map<string, int>()
m.set("a", 1)
m.set("b", 2)
m.set("a", 99)
Console.write("\\{m.length} \\{m.get_or("a", 0)} \\{m.get_or("b", 0)}")
`;
	await build_and_check_output(input, "map_stored_hash_replace", "2 99 2");
});

test("Map copy carries used and hash words (lookups work on the copy)", async () => {
	const input = `
var Map<string, int> m = Map<string, int>()
var i = 0
while i < 100 {
	m.set("k\\{i}", i)
	i += 1
}
var Map<string, int> c = m.copy()
c.remove("k0")
c.set("k1", 111)
Console.write("\\{c.length} \\{m.get_or("k1", 0)} \\{c.get_or("k1", 0)} \\{c.get_or("k50", -1)} \\{c.get_or("k0", -1)} \\{m.get_or("k0", -1)}")
`;
	await build_and_check_output(input, "map_stored_hash_copy", "99 1 111 50 -1 0");
});

test("Set<string> survives rehash growth, remove, and re-lookup", async () => {
	const input = `
var Set<string> s = Set<string>()
var i = 0
while i < 300 {
	s.add("s\\{i}")
	i += 1
}
i = 0
while i < 300; i += 3 {
	s.remove("s\\{i}")
}
var int hits = 0
i = 0
while i < 300; i += 1 {
	if s.has("s\\{i}") {
		hits += 1
	}
}
Console.write("\\{s.length} \\{hits} \\{s.has("s1")} \\{s.has("s3")}")
`;
	await build_and_check_output(input, "set_stored_hash_growth_remove", "200 200 true false");
});

test("Set copy carries used and hash words", async () => {
	const input = `
var Set<int> s = Set<int>()
var i = 0
while i < 50 {
	s.add(i)
	i += 1
}
var Set<int> c = s.copy()
c.remove(7)
Console.write("\\{c.length} \\{s.length} \\{c.has(7)} \\{s.has(7)} \\{c.has(49)}")
`;
	await build_and_check_output(input, "set_stored_hash_copy", "49 50 false true true");
});
