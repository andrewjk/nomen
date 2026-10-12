import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// The nested-mv-user-struct half of the container-element field deep copy
// (FOLLOWUP.md, "Owning container fields in container elements"): a value
// struct whose member is ANOTHER mv struct that owns heap data (a `Map`/
// `Buffer`/`string` field) stored in a `List` reads back through `at` as a
// struct copy — and the binding's teardown reclaims owning nested-struct
// fields, so the loaded copy must own an INDEPENDENT inner value or the
// caller and the slot double-free. `load_T` composes the inner struct's
// (auto-derived) `copy` for this; audit ON: the shallow load used to abort
// at teardown (stale free).

describe("nested mv struct field in a List element", () => {
	test("read back owns an independent Map-carrying inner struct", async () => {
		const input = `
mv struct Inner {
	var Map<string, int> data = Map<string, int>()
}

mv struct Outer {
	var Inner inner = Inner()
}

var list = List<Outer>()
var o = Outer()
o.inner.data.set("k", 7)
list.push(mv o)
var loaded = list.at_or_panic(0)
Console.write("n=\\{loaded.inner.data.length}\\n")
loaded.inner.data.remove("k")
var again = list.at_or_panic(0)
Console.write("still=\\{again.inner.data.get_or_panic("k")}\\n")
`;
		await build_and_check_output(input, "nested_field_map", "n=1\nstill=7\n");
	});

	test("read back owns an independent Buffer-carrying inner struct", async () => {
		// No indexed store here: a two-level field path (`o.inner.buf`) has no
		// tracked cap fact, so `store_int`'s `i < self.cap` constraint cannot
		// verify. The slab from `alloc` is ownership-relevant on its own — the
		// audit runtime catches the shallow load's double-free at teardown.
		const input = `
mv struct Inner {
	var Buffer<int> buf = Buffer<int>()
}

mv struct Outer {
	var Inner inner = Inner()
}

var list = List<Outer>()
var o = Outer()
var _ = o.inner.buf.alloc(4)
list.push(mv o)
var loaded = list.at_or_panic(0)
Console.write("cap=\\{loaded.inner.buf.cap}\\n")
`;
		await build_and_check_output(input, "nested_field_buffer", "cap=4\n");
	});

	test("read back owns an independent string-carrying inner struct", async () => {
		const input = `
mv struct Inner {
	var string name = ""
}

mv struct Outer {
	var Inner inner = Inner()
}

var list = List<Outer>()
var o = Outer()
o.inner.name = "alpha"
list.push(mv o)
var loaded = list.at_or_panic(0)
Console.write("n=\\{loaded.inner.name}\\n")
loaded.inner.name = "changed"
var again = list.at_or_panic(0)
Console.write("still=\\{again.inner.name}\\n")
`;
		await build_and_check_output(input, "nested_field_string", "n=alpha\nstill=alpha\n");
	});
});
