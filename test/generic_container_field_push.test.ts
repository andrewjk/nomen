import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Nested container monos behind user generics: a generic struct's
// container-typed field (`Holder<T> { var items = StableList<T>() }`)
// instantiated over another container or over a struct holding one. The
// push argument must lower through the in-place splice with every chain
// hop addressed against its MONOMORPHIZED layout — a generic-spelled root
// type used to defeat the splice's field-path walk and leave invalid C
// (`&Leaf_init()`, address of an rvalue) in the generated source. Both
// backends run these binaries: the splice's reserve/construct/bump
// sequence, the mono destroy chain, and the audit balance are exercised
// for real.

test("generics -- container field push through a generic local (Holder<Leaf>)", async () => {
	const input = `
struct Leaf {
	var value = 0
}

mv struct Holder<T> {
	var items = StableList<T>()
}

var h = Holder<Holder<Leaf>>()
var inner = Holder<Leaf>()
var leaf = Leaf()
leaf.value = 42
inner.items.push(mv leaf)
h.items.push(mv inner)
Console.write_line(h.items.at_or_panic(0).items.at_or_panic(0).value.to_string())
Console.write_line(h.items.length.to_string())
`;
	await build_and_check_output(input, "generic_container_holder_push", "42\n1\n");
});

test("generics -- two-hop field path through nested generic field (Wrap<Leaf>)", async () => {
	const input = `
struct Leaf {
	var value = 0
}

mv struct Holder<T> {
	var items = StableList<T>()
}

mv struct Wrap<T> {
	var h = Holder<T>()
}

var w = Wrap<Leaf>()
w.h.items.push(Leaf())
var second = Leaf()
second.value = 7
w.h.items.push(mv second)
Console.write_line(w.h.items.at_or_panic(0).value.to_string())
Console.write_line(w.h.items.at_or_panic(1).value.to_string())
Console.write_line(w.h.items.length.to_string())
`;
	await build_and_check_output(input, "generic_container_wrap_push", "0\n7\n2\n");
});

test("generics -- generic over a container (Holder<StableList<Leaf>>)", async () => {
	const input = `
struct Leaf {
	var value = 0
}

mv struct Holder<T> {
	var items = StableList<T>()
}

var h = Holder<StableList<Leaf>>()
var inner = StableList<Leaf>()
var leaf = Leaf()
leaf.value = 9
inner.push(mv leaf)
h.items.push(mv inner)
h.items.push(StableList<Leaf>())
Console.write_line(h.items.at_or_panic(0).at_or_panic(0).value.to_string())
Console.write_line(h.items.length.to_string())
Console.write_line(json_encode(ref h))
`;
	await build_and_check_output(
		input,
		"generic_container_nested_push",
		'9\n2\n{"items":[[{"value":9}],[]]}\n',
	);
});

test("generics -- generic instantiated over a struct holding a container", async () => {
	const input = `
mv struct Leaf {
	var inner = StableList<int>()
}

mv struct Holder<T> {
	var items = StableList<T>()
}

var h = Holder<Leaf>()
var leaf = Leaf()
leaf.inner.push(7)
h.items.push(mv leaf)
Console.write_line(h.items.at_or_panic(0).inner.at_or_panic(0).to_string())
Console.write_line(h.items.length.to_string())
Console.write_line(json_encode(ref h))
`;
	// The json_encode line is the comptime-json crash shape (2026-11-16): the
	// generic-mono element pushed with `mv`, then encoded — the element's
	// encode recurses into another container mono and segfaulted aarch64 in
	// the closing inline append (x19/x20 zeroed mid-splice). Fixed by the
	// full idempotent mono destroy + StableList load deep-copy; kept here as
	// the regression lock (audit on, both backends).
	await build_and_check_output(
		input,
		"generic_container_struct_holding",
		'7\n1\n{"items":[{"inner":[7]}]}\n',
	);
});

test("generics -- container-field generics check clean for the raw program", () => {
	const input = `
struct Leaf {
	var value = 0
}

mv struct Holder<T> {
	var items = StableList<T>()
}

mv struct Wrap<T> {
	var h = Holder<T>()
}

var h = Holder<Holder<Leaf>>()
var inner = Holder<Leaf>()
inner.items.push(Leaf())
h.items.push(mv inner)
var w = Wrap<StableList<Leaf>>()
Console.write_line(h.items.at_or_panic(0).items.at_or_panic(0).value.to_string())
Console.write_line(w.h.items.length.to_string())
`;
	expect(parse_with_imports(input).errors).toEqual([]);
});
