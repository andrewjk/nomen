import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Map/Set.remove no-shift strand: when a remove's backward-shift scan finds
// an empty successor slot (no shifts — the common case in sparse tables),
// the removed entry's owning fields stayed in its slot while `used` dropped
// to 0. The container destroy still frees them (remove-then-destroy was
// leak-clean), but a later set()/add() landing in that hole stores over the
// bytes through store/store_take, which assume a fresh slot — the stranded
// entry leaked. The fix reclaims (destroy_at: free + zero) in the no-shift
// case, guarded per element kind so scalar tables fold it away entirely
// (the emitted Map<int,int>/Set<int> remove is byte-identical to before).

describe("map/set remove strand (no-shift reclaim)", () => {
	test("owning-struct value survives remove + colliding re-insert", async () => {
		const input = `
mv struct Rec {
	var name = ""
	var n = 0
}

var m = Map<int, Rec>()
var r1 = Rec()
r1.name = "one"
m.set(1, mv r1)
var r9 = Rec()
r9.name = "nine"
m.set(9, mv r9)
// 1 and 9 home to the same slot at cap 8; 9 sits behind 1, and its
// successor slot is empty — remove scans no shifts and strands it.
m.remove(9)
// the colliding re-insert lands in the stranded hole
var r9b = Rec()
r9b.name = "nine-b"
m.set(9, mv r9b)
Console.write("\\{m.has(9)}")
`;
		await build_and_check_output(input, "strand_map_rec_value", "true");
	});

	test("string value survives remove + colliding re-insert", async () => {
		const input = `
var m = Map<int, string>()
m.set(1, "one")
m.set(9, "nine")
m.remove(9)
m.set(9, "nine-b")
Console.write("\\{m.has(9)}")
`;
		await build_and_check_output(input, "strand_map_string_value", "true");
	});

	test("shift path still moves owning entries wholesale", async () => {
		const input = `
mv struct Rec {
	var name = ""
	var n = 0
}

var m = Map<int, Rec>()
var r1 = Rec()
r1.name = "one"
m.set(1, mv r1)
var r9 = Rec()
r9.name = "nine-b"
m.set(9, mv r9)
// remove the cluster head: 9 shifts into the vacated slot
m.remove(1)
var got = m.get_or(9, Rec())
Console.write("\\{m.length} \\{got.name}")
`;
		await build_and_check_output(input, "strand_map_shift_path", "1 nine-b");
	});

	test("remove-then-destroy stays leak-clean", async () => {
		const input = `
mv struct Rec {
	var name = ""
	var n = 0
}

var m = Map<int, Rec>()
var r1 = Rec()
r1.name = "one"
m.set(1, mv r1)
var r9 = Rec()
r9.name = "nine"
m.set(9, mv r9)
m.remove(9)
Console.write("\\{m.length}")
`;
		await build_and_check_output(input, "strand_map_remove_then_destroy", "1");
	});

	test("string-key churn (mixed no-shift and shift removes)", async () => {
		const input = `
var m = Map<string, int>()
var int i = 0
while i < 64 {
	m.set("k\\{i}", i)
	i += 1
}
var int r = 0
while r < 64 {
	m.remove("k\\{r}")
	r += 2
}
var int i2 = 0
while i2 < 64 {
	m.set("k\\{i2}", i2 + 100)
	i2 += 2
}
Console.write("\\{m.length}")
`;
		await build_and_check_output(input, "strand_map_string_keys_churn", "64");
	});

	test("set string churn reclaims stranded slots", async () => {
		const input = `
var s = Set<string>()
var int i = 0
while i < 64 {
	s.add("s\\{i}")
	i += 1
}
var int r = 0
while r < 64 {
	s.remove("s\\{r}")
	r += 2
}
Console.write("\\{s.length}")
`;
		await build_and_check_output(input, "strand_set_string_churn", "32");
	});

	test("value-struct key churn (Set<Rec>, C address-of-rvalue fix)", async () => {
		// `find_slot` compares the slot's key with the probe value through the
		// element's `==`. The C backend used to emit `&Buffer_Rec_load(...)` —
		// the address of a BY-VALUE call result, which clang rejects — so a
		// `Set<Rec>` never compiled. The operand is now materialized into a
		// temp before the operator call.
		const input = `
mv struct Rec: Hashable, Equatable {
	var int key
	var string name
}

var Set<Rec> s = Set<Rec>()
var int i = 0
while i < 16 {
	s.add(Rec(i, "k\\{i}"))
	i += 1
}
var int r = 0
while r < 16 {
	s.remove(Rec(r, "k\\{r}"))
	r += 2
}
Console.write("\\{s.length} \\{s.has(Rec(1, "k\\{1}"))} \\{s.has(Rec(2, "k\\{2}"))}")
`;
		await build_and_check_output(input, "strand_set_rec_keys_churn", "8 true false");
	});

	test("value-struct key churn (Map<Rec, int>)", async () => {
		const input = `
mv struct Rec: Hashable, Equatable {
	var int key
	var string name
}

var m = Map<Rec, int>()
var int i = 0
while i < 8 {
	m.set(Rec(i, "k\\{i}"), i * 10)
	i += 1
}
m.remove(Rec(0, "k0"))
m.set(Rec(8, "k8"), 80)
Console.write("\\{m.length} \\{m.get_or(Rec(3, "k3"), -1)} \\{m.get_or(Rec(8, "k8"), -1)} \\{m.has(Rec(0, "k0"))}")
`;
		await build_and_check_output(input, "strand_map_rec_keys_churn", "8 30 80 false");
	});
});
