import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A value struct whose member is a heap-mv CONTAINER other than `List`
// (`Buffer`), stored in a `List<that-struct>`: reading it back with `at`
// returns a struct copy, and a struct local's container fields are reclaimed
// unconditionally at scope exit — so the returned copy must own an
// INDEPENDENT container or the caller and the slot double-free the slab.
// `load_T` now deep-copies `List`/`Buffer` element fields via their mono
// `copy` (mirroring the `List<T>`-member treatment from 0.6.7). Audit ON:
// this used to abort at teardown (`free of object 0x4`).

describe("Buffer member in a List element", () => {
	test("read back owns an independent Buffer", async () => {
		const input = `
struct Holder {
	var buf = Buffer<int>()
}

var list = List<Holder>()
var h = Holder()
var _ = h.buf.alloc(4)
h.buf.store_int(1, 42)
list.push(mv h)
Console.write("len=\\{list.length}\\n")
var loaded = list.at_or_panic(0)
Console.write("cap=\\{loaded.buf.cap}\\n")
`;
		await build_and_check_output(input, "container_field_buffer", "len=1\ncap=4\n");
	});

	test("nested List member still deep-copies alongside a Buffer member", async () => {
		const input = `
struct Holder {
	var buf = Buffer<int>()
	var vals = List<int>()
}

var list = List<Holder>()
var h = Holder()
var _ = h.buf.alloc(4)
h.buf.store_int(1, 7)
h.vals.push(1)
h.vals.push(2)
list.push(mv h)
var loaded = list.at_or_panic(0)
Console.write("cap=\\{loaded.buf.cap} n=\\{loaded.vals.length}\\n")
`;
		await build_and_check_output(input, "container_field_buffer_list", "cap=4 n=2\n");
	});
});

// Owned FIELDS of a List element: the mv load_T deep-copies them so the
// loaded copy's scope-exit destroy frees its own state — never the slot's
// (a shallow copy made the list's later destroy a stale free). Audit ON:
// either failure mode fails the run. The enum case was aarch64-only (the
// C backend always rode `<E>_copy`).
describe("owned fields of a List element", () => {
	test("Box field of a container element is cloned on load", async () => {
		const input = `
mv struct Payload {
	var int v
}
mv struct Cell {
	var Box<Payload> payload
}
var List<Cell> l = List<Cell>()
l.push(mv Cell(mv Box<Payload>(Payload(5))))
var Cell n = l.at_or_panic(0)
Console.write("\\{n.payload.v}\\n")
`;
		await build_and_check_output(input, "container_field_box_elem", "5\n");
	});

	test("enum-with-data field of a container element is deep-copied", async () => {
		const input = `
mv enum Val {
	case text(string s)
	case none
}
mv struct Cell {
	var Val v
}
var List<Cell> l = List<Cell>()
l.push(mv Cell(Val.text("abc".to_string())))
var Cell n = l.at_or_panic(0)
match n.v {
	case .text(s) {
		Console.write("\\{s}\\n")
	}
	case .none {
		Console.write("none\\n")
	}
}
`;
		await build_and_check_output(input, "container_field_enum_elem", "abc\n");
	});

	// The chained Box deref through the accessor result (the shape that used
	// to fail checking with the internal "Unknown value: _recv_N" — the
	// Box transparent-access rewrite re-walks the hoisted receiver temp).
	// Audit ON: the hoisted temp must still reach its scope-exit destroy.
	test("chained Box deref through an accessor result builds and runs", async () => {
		const input = `
mv struct Payload {
	var int v
}
mv struct Cell {
	var Box<Payload> payload
}
var List<Cell> l = List<Cell>()
l.push(mv Cell(mv Box<Payload>(Payload(5))))
Console.write("\\{l.at_or_panic(0).payload.v}\\n")
`;
		await build_and_check_output(input, "container_field_chained_deref", "5\n");
	});
});

// `Buffer.copy` deep-copies every slot (a fresh slab and, for mv
// elements, an independent copy per element) — the primitive the load
// deep-copy and `List`/`Map`/`Set` copies compose from.
describe("Buffer.copy", () => {
	test("scalar elements copy into an independent slab", async () => {
		const input = `
var b = Buffer<int>()
var _ = b.alloc(4)
b.store_int(1, 7)
var c = b.copy()
c.store_int(2, 9)
Console.write("c1=\\{c.load_int(1)} c2=\\{c.load_int(2)} b1=\\{b.load_int(1)}\\n")
`;
		await build_and_check_output(input, "buffer_copy_int", "c1=7 c2=9 b1=7\n");
	});

	test("string elements are deep-copied (source keeps its slot)", async () => {
		const input = `
var s = Buffer<string>()
var _ = s.alloc(2)
s.replace(1, "hello")
var s2 = s.copy()
Console.write("s2=\\{s2.load(1).to_string()} s1=\\{s.load(1).to_string()}\\n")
`;
		await build_and_check_output(input, "buffer_copy_string", "s2=hello s1=hello\n");
	});
});
