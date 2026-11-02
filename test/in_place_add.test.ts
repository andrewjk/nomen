import { describe, expect, test } from "vite-plus/test";

import build, { default_platform } from "../src/build";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// The in-place construction guarantee, `add`/`alloc` sibling tranche: the
// container `add`/`alloc` family takes an owned `mv T value` and stores it
// into a freshly grown slot. Before the transfer store the callee deep-copied
// the value into the slot (a second strdup per string field) and the caller
// freed the producer's temp. `Buffer<T>.store_take` moves the value instead:
// the slot takes the bytes and the caller's storage zeroes, so the producer's
// allocation IS the store. The generic bodies pick the arm through the
// per-instantiation `T_IS_VALUE_STRUCT` constant (a by-reference value-struct
// parameter is the only shape a move is sound for — strings arrive as
// by-value pairs, classes as shared pointers, so those keep `store`).

describe("in-place add/alloc: the take-store siblings", () => {
	const rec_program = (body: string): string => `
import System

mv struct Rec {
	var name = ""
	var int n = 0
}

func make = (int i, out Rec) {
	var r = Rec()
	r.name = "v" + i.to_string()
	r.n = i
	return r
}

pub func main = (Init init) {
${body}
}
`;

	test("LinkedList.add moves the produced value into the node slot", async () => {
		const input = rec_program(`
	var l = LinkedList<Rec>()
	l.add(make(1))
	l.add(make(2))
	var donor = make(3)
	l.add(mv donor)
	Console.write(l.count.to_string())
	Console.write(" ")
	Console.write(l.at_or_panic(2).n.to_string())
	Console.write("\\n")
`);
		await build_and_check_output(input, "inplace_add_linked_list", "3 3\n", true);
	});

	test("Map.set's insert path moves the produced value into the value slot", async () => {
		const input = rec_program(`
	var m = Map<int, Rec>()
	m.set(1, make(1))
	m.set(2, make(2))
	Console.write(m.length.to_string())
	Console.write(" ")
	Console.write(m.has(2).to_string())
	Console.write("\\n")
`);
		await build_and_check_output(input, "inplace_add_map_insert", "2 true\n", true);
	});

	test("string elements keep the deep-copying store (the pair arrives by value)", async () => {
		const input = `
import System

func make = (int i, out string) {
	return "v" + i.to_string()
}

pub func main = (Init init) {
	var s = Set<string>()
	s.add(make(1))
	s.add(make(2))
	var l = LinkedList<string>()
	l.add(make(3))
	var m = Map<int, string>()
	m.set(1, make(4))
	Console.write(s.length.to_string() + " " + l.count.to_string() + " " + m.length.to_string() + "\\n")
}
`;
		await build_and_check_output(input, "inplace_add_strings", "2 1 1\n", true);
	});

	test("scalar elements keep the plain store", async () => {
		const input = `
import System

func seed = (int i, out int) {
	return i * 10
}

pub func main = (Init init) {
	var l = LinkedList<int>()
	l.add(seed(1))
	l.add(seed(2))
	var m = Map<int, int>()
	m.set(1, seed(3))
	Console.write(l.count.to_string() + " " + m.length.to_string() + "\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: default_platform() });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		const add_at = code.indexOf("void LinkedList_int_add(");
		expect(add_at).toBeGreaterThan(0);
		const add_body = code.slice(add_at, add_at + 400);
		expect(add_body).toContain("Buffer_int_store(");
		expect(add_body).not.toContain("store_take");
		await build_and_check_output(input, "inplace_add_scalars", "2 1\n", true);
	});

	test("the emitted add/push/store_in_slab bodies take; the string mono copies", async () => {
		const input = `
import System

mv struct Rec {
	var name = ""
	var int n = 0
}

func make = (int i, out Rec) {
	var r = Rec()
	r.name = "v" + i.to_string()
	r.n = i
	return r
}

pub func main = (Init init) {
	var l = LinkedList<Rec>()
	l.add(make(1))
	var ls = LinkedList<string>()
	ls.add("s")
	var xs = List<Rec>()
	var d = make(2)
	xs.push(mv d)
	var sl = StableList<Rec>()
	var d2 = make(3)
	sl.push(mv d2)
	var m = Map<int, Rec>()
	m.set(1, make(4))
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: default_platform() });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		const body_of = (label: string): string => {
			const at = code.indexOf(label);
			expect(at, `${label} emitted`).toBeGreaterThan(0);
			return code.slice(at, at + 700);
		};
		// The value-struct mono bodies move the value into the slot.
		expect(body_of("void LinkedList_Rec_add(")).toContain("Buffer_Rec_store_take(");
		expect(body_of("void List_Rec_push(")).toContain("Buffer_Rec_store_take(");
		expect(body_of("void Buffer_Rec_store_in_slab(")).toContain("store_take(");
		// ... and never deep-copy.
		expect(body_of("void LinkedList_Rec_add(")).not.toContain("Rec_copy");
		// The string mono keeps the deep-copying store (its pair arrives by value).
		const string_add = body_of("void LinkedList_string_add(");
		expect(string_add).toContain("Buffer_string_store(");
		expect(string_add).not.toContain("Buffer_string_store_take(");
	});
});
