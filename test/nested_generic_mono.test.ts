import { expect, test } from "vite-plus/test";

import check from "../src/check";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Nested generics inside generic struct bodies must monomorphize: a field
// shaped `List<Box<T>>` (any Generic<G<T>> in a generic struct's own body)
// materializes every nested mono (`Box_int`, `ClassBuffer_Box_int`,
// `List_Box_int`) and the cloned method bodies dispatch through the
// field's REWRITTEN mono (Buffer→ClassBuffer), not the substituted
// annotation spelling — previously the aarch64 clone bodies emitted calls
// to a never-materialized `Buffer_Box_int_grow` (link failure), and a
// `mv`-declared field substituted to a non-owning type (`Box<int>`'s
// `mv T __value` → `int`) synthesized an illegal `var` init param
// (check error).

test("Box over a scalar pointee", async () => {
	// `mv T __value` substituted to `int`: the synthesized init param stays a
	// plain read-only binding (the mv is a no-op on a non-owning type).
	const input = `
var Box<int> b = Box<int>(42)
Console.write("\\{b.__value}")
`;
	await build_and_check_output(input, "nested_mono_box_scalar", "42");
});

test("Box<Box<int>> — nested over a scalar", async () => {
	const input = `
var Box<Box<int>> b = Box<Box<int>>(Box<int>(7))
Console.write("\\{b.__value.__value}")
`;
	await build_and_check_output(input, "nested_mono_box_box_scalar", "7");
});

test("List<Box<T>> field in a generic body, scalar element", async () => {
	const input = `
mv struct Outer<T> {
	var List<Box<T>> items = List<Box<T>>()
}
var Outer<int> o = Outer<int>()
o.items.push(Box<int>(5))
if o.items.length > 0 {
	Console.write("\\{o.items.length} \\{o.items.at(0).__value}")
}
`;
	await build_and_check_output(input, "nested_mono_list_box_scalar", "1 5");
});

test("template method constructs the nested generic", async () => {
	// The cloned `add` body's `self.items.push(...)` must dispatch through
	// the field's rewritten mono (ClassBuffer_Box_Packed), not the stale
	// substituted `Buffer<Box<Packed>>` spelling (aarch64 link failure).
	const input = `
mv struct Packed {
	var int v
}
mv struct Outer<T> {
	var List<Box<T>> items = List<Box<T>>()

	pub func add = (ref self, T value) {
		self.items.push(Box<T>(value))
	}
}
var Outer<Packed> o = Outer<Packed>()
o.add(Packed(3))
o.add(Packed(4))
Console.write("\\{o.items.length} \\{o.items.pop().v} \\{o.items.pop().v}")
`;
	await build_and_check_output(input, "nested_mono_method_ctor", "2 4 3");
});

test("template method returns the nested generic element", async () => {
	const input = `
mv struct Packed {
	var int v
}
mv struct Outer<T> {
	var List<Box<T>> items = List<Box<T>>()

	pub func add = (ref self, T value) {
		self.items.push(Box<T>(value))
	}

	pub func first_or_new = (ref self, T fallback, out Box<T>) {
		if self.items.length > 0 {
			return self.items.at(0)
		}
		var Box<T> fresh = Box<T>(fallback)
		self.items.push(fresh)
		return fresh
	}
}
var Outer<Packed> o = Outer<Packed>()
o.add(Packed(9))
var Box<Packed> b = o.first_or_new(Packed(1))
Console.write("\\{b.v}")
`;
	await build_and_check_output(input, "nested_mono_method_return", "9");
});

test("List<List<T>> field and method pushing into the nesting", async () => {
	const input = `
mv struct Outer<T> {
	var List<List<T>> items = List<List<T>>()

	pub func seed = (ref self, T value) {
		var List<T> inner = List<T>()
		inner.push(value)
		self.items.push(inner)
	}
}
var Outer<int> o = Outer<int>()
o.seed(5)
if o.items.length > 0 {
	Console.write("\\{o.items.length} \\{o.items.at(0).pop()}")
}
`;
	await build_and_check_output(input, "nested_mono_list_list", "1 5");
});

test("List<Box<Buffer<T>>> — the StableList-v2 shape", async () => {
	const input = `
mv struct Outer<T> {
	var List<Box<Buffer<T>>> items = List<Box<Buffer<T>>>()

	pub func add = (ref self, T value) {
		var Buffer<T> buf = Buffer<T>()
		buf.grow(4)
		buf.store(0, value)
		self.items.push(Box<Buffer<T>>(mv buf))
	}
}
var Outer<int> o = Outer<int>()
o.add(11)
if o.items.length > 0 {
	Console.write("\\{o.items.length} \\{o.items.at(0).load(0)}")
}
`;
	await build_and_check_output(input, "nested_mono_list_box_buffer", "1 11");
});

test("two-level nesting: the inner arg references the outer param", async () => {
	// Top<U>'s field `Mid<List<U>>` — the nested argument still names Top's
	// own type param, so the whole chain materializes only at Top's mono.
	const input = `
mv struct Mid<T> {
	var List<Box<T>> items = List<Box<T>>()
}
mv struct Top<U> {
	var Mid<List<U>> mid = Mid<List<U>>()
}
var Top<int> t = Top<int>()
t.mid.items.push(Box<List<int>>(List<int>()))
if t.mid.items.length > 0 {
	Console.write("\\{t.mid.items.length}")
}
`;
	await build_and_check_output(input, "nested_mono_two_level", "1");
});

test("nested generic field types materialize the full mono chain", () => {
	// Every nested mono in the chain is materialized — no half-cloned links
	// (`List_Box_int`, its `ClassBuffer_Box_int` backing, `Box_int`).
	const input = `
mv struct Outer<T> {
	var List<Box<T>> items = List<Box<T>>()
}
var Outer<int> o = Outer<int>()
o.items.push(Box<int>(5))
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const checked = check(parsed.root);
	expect(checked.errors.filter((e) => !e.message.includes("void"))).toEqual([]);
	const names = parsed.root.statements
		.filter((s) => (s as { node_type: string }).node_type === "struct")
		.map((s) => (s as { name?: string }).name);
	for (const mono of ["Outer_int", "List_Box_int", "ClassBuffer_Box_int", "Box_int"]) {
		expect(names).toContain(mono);
	}
});
