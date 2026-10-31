import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// A Map whose value type is a user `mv struct` used to poison every
// `<Struct>(...)` constructor call in the program: Map's variadic-pairs
// `#init` is cloned + re-checked at monomorphization, its body
// mv-DESTRUCTURES each pair (`var [mv k, mv v] = pairs.at(i)`), and the
// revalidating swap was synthesized as a bare zero-argument constructor
// call — which a struct with REQUIRED parameters does not have
// ("Parameters missing for function: <Struct>", reported at a bogus
// position inside the joined library source, even for a ctor call in an
// uncalled function defined before the Map declaration). The swap now
// synthesizes the constructor's zero-value arguments (0 / false / '\0' /
// "" / null / a nested empty), so declaring `Map<K, UserStruct>` is inert
// and struct-valued Maps work in-source on both backends. A struct whose
// constructor has a REQUIRED parameter no zero literal can fill (a
// non-nullable Box, a func/array-typed field without a default) swaps in a
// ZEROED SLOT instead — the `{0}` compound-literal treatment struct
// returns have, generalized to the checker-side swap — so every
// pairs-ctor TV declares.

describe("Map with user-struct values", () => {
	test("the declaration does not poison ctor calls elsewhere in the program", () => {
		// The ctor call sits in an uncalled function defined BEFORE the Map
		// declaration — the shape the follow-up recorded.
		const input = `
import System

mv struct Point {
	var int x
	var int y
}

func make = (out Point) {
	return Point(1, 2)
}

func untouched = (out int) {
	var Point p = Point(3, 4)
	return p.x + p.y
}

pub func main = (Init init) {
	var m = Map<string, Point>()
	Console.write("\\{untouched()}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
	});

	test("scalar- and string-field values set, get, and destroy soundly", async () => {
		const input = `
import System

mv struct Config {
	var string name
	var int n
}

pub func main = (Init init) {
	var m = Map<string, Config>()
	m.set("k", Config("hello", 7))
	var Config c = m.get_or_panic("k")
	Console.write("\\{c.name},\\{c.n} \\{m.length}")
}
`;
		await build_and_check_output(input, "map_struct_values_set_get", "hello,7 1", true);
	});

	test("nested struct values (the swap synthesizes nested empties)", async () => {
		const input = `
import System

mv struct Point {
	var int x
	var int y
}

mv struct Outer {
	var Point p
	var int tag
}

pub func main = (Init init) {
	var m = Map<string, Outer>()
	m.set("o", Outer(Point(1, 2), 42))
	var Outer o = m.get_or_panic("o")
	Console.write("\\{o.p.x},\\{o.p.y} \\{o.tag}")
}
`;
		await build_and_check_output(input, "map_struct_values_nested", "1,2 42", true);
	});

	test("variadic pairs constructor with struct values", async () => {
		const input = `
import System

mv struct Point {
	var int x
	var int y
}

pub func main = (Init init) {
	var m = Map<string, Point>(["a", Point(5, 6)])
	var Point pa = m.get_or_panic("a")
	Console.write("\\{pa.x},\\{pa.y} \\{m.length}")
}
`;
		await build_and_check_output(input, "map_struct_values_pairs_ctor", "5,6 1", true);
	});

	test("mixed field kinds: bool, char, float, nullable Box, enum", async () => {
		const input = `
import System

enum Color {
	case red
	case green
}

mv struct Count {
	var int n
}

mv struct Mixed {
	var bool flag
	var char letter
	var float ratio
	var Box<Count>? extra
	var string label
	var Color c
}

mv struct Wrap {
	var Mixed m
}

pub func main = (Init init) {
	var m = Map<string, Mixed>()
	m.set("a", Mixed(true, 'x', 1.5, null, "ok", Color.green))
	var Mixed a = m.get_or_panic("a")
	Console.write("\\{a.flag} \\{a.letter} \\{a.ratio} \\{a.label} \\{a.c == Color.green}")

	var w = Map<string, Wrap>()
	w.set("b", Wrap(Mixed(false, 'y', 2.25, Box<Count>(Count(3)), "deep", Color.red)))
	var Wrap b = w.get_or_panic("b")
	Console.write(" \\{b.m.label}")
	var Box<Count>? held = b.m.extra
	if held != null {
		Console.write(" \\{held.n}")
	}
}
`;
		await build_and_check_output(
			input,
			"map_struct_values_mixed_kinds",
			"true x 1.500000 ok true deep 3",
			true,
		);
	});

	test("a struct with no synthesizable empty value declares inertly", () => {
		// A required non-nullable Box parameter has no zero literal — the
		// synthesized swap cannot fill a constructor call, so it swaps in a
		// zeroed slot instead and the declaration checks clean (it used to
		// error with a dedicated "no empty value" message).
		const input = `
import System

mv struct Holds {
	var Box<int> b
	var int n
}

pub func main = (Init init) {
	var m = Map<string, Holds>()
	Console.write("\\{m.length}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
	});

	test("required-Box struct values set, get, and destroy soundly", async () => {
		// The zeroed-slot swap must leave every moved-from pair slot holding
		// NULL heap words — the audit run catches a leak, double-free, or
		// stale free of the boxes on both backends.
		const input = `
import System

mv struct Holds {
	var Box<int> b
	var int n
}

pub func main = (Init init) {
	var m = Map<string, Holds>()
	m.set("a", Holds(Box<int>(7), 5))
	m.set("b", Holds(Box<int>(9), 2))
	var Holds ha = m.get_or_panic("a")
	var Holds hb = m.get_or_panic("b")
	Console.write("\\{ha.b},\\{ha.n} \\{hb.b},\\{hb.n} \\{m.length}")
}
`;
		await build_and_check_output(input, "map_struct_values_required_box", "7,5 9,2 2", true);
	});

	test("nested struct whose field struct itself has no empty value", async () => {
		// Wrap's required Holds parameter is itself unconstructible-empty, so
		// BOTH levels swap in zeroed slots (a zeroed Wrap zero-fills its
		// Holds field, whose zeroed Box word is NULL).
		const input = `
import System

mv struct Holds {
	var Box<int> b
	var int n
}

mv struct Wrap {
	var Holds h
	var string tag
}

pub func main = (Init init) {
	var w = Map<string, Wrap>()
	w.set("k", Wrap(Holds(Box<int>(4), 1), "t"))
	var Wrap v = w.get_or_panic("k")
	Console.write("\\{v.h.b},\\{v.h.n},\\{v.tag}")
}
`;
		await build_and_check_output(input, "map_struct_values_nested_required_box", "4,1,t", true);
	});
});
