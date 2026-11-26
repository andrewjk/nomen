import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

const opts = { audit: true, js: true };

// `Array<T>?`: a heap array that may itself be null (`Type.is_nullable_array`;
// `is_nullable` on an array type means its ELEMENTS are nullable). A heap
// array is a pointer, so null is the null pointer.
describe("nullable arrays", () => {
	test("declare, store, compare and narrow", async () => {
		const input = `import System
pub func main = () {
	var Array<int>? a = null
	var Array<string>? s = null
	var o = "\\{a == null}"
	s = ["x", "yy"]
	if s != null {
		o = o + " " + s.at_or(1, "-")
	}
	s = null
	if s == null {
		o = o + " null"
	}
	s = ["p", "q", "r"]
	if s != null {
		o = o + " \\{s.length}"
	}
	a = [1, 2, 3]
	if a != null {
		o = o + " \\{a.at_or(2, 0)}"
	}
	Console.write_line(o)
}
`;
		await build_and_check_output(input, "nullable_array_locals", "true yy null 3 3", true, opts);
	});

	test("?? borrows the live array", async () => {
		const input = `import System
pub func main = () {
	var Array<int>? a = null
	const Array<int> fb = [7, 8]
	const t1 = a ?? fb
	const n0 = (a ?? [4, 5, 6, 7]).length
	a = [1, 2, 3]
	const t2 = a ?? fb
	Console.write_line("\\{t1.length} \\{n0} \\{(a ?? fb).length} \\{t2.at_or(2, 0)}")
}
`;
		await build_and_check_output(input, "nullable_array_coalesce", "2 4 3 3", true, opts);
	});

	test("parameters and returns", async () => {
		const input = `import System
func count = (Array<int>? xs, out int) {
	if xs == null {
		return -1
	}
	return xs.length
}
func make = (int n, out Array<string>?) {
	if n <= 0 {
		return null
	}
	return Array<string>.with("ab", n)
}
pub func main = () {
	const Array<int> a = [1, 2]
	const m = make(3)
	const z = make(0)
	var o = "\\{count(a)} \\{count(null)}"
	if m != null {
		o = o + " \\{m.length}" + m.at_or(0, "-")
	}
	if z == null {
		o = o + " none"
	}
	Console.write_line(o)
}
`;
		await build_and_check_output(input, "nullable_array_params", "2 -1 3ab none", true, opts);
	});

	test("struct fields", async () => {
		const input = `import System
mv struct Bag {
	var Array<string>? items
}
pub func main = () {
	var b = Bag(null)
	var o = "\\{b.items == null}"
	b.items = ["a", "bb"]
	if b.items != null {
		o = o + " \\{b.items.length}"
	}
	b.items = null
	o = o + " \\{b.items == null}"
	b.items = ["c"]
	var c = Bag(["x", "y", "z"])
	if c.items != null {
		o = o + " \\{c.items.length}"
	}
	Console.write_line(o)
}
`;
		await build_and_check_output(input, "nullable_array_fields", "true 2 true 3", true, opts);
	});

	test("nested nullable arrays", async () => {
		const input = `import System
pub func main = () {
	var Array<Array<string>>? g = null
	var Array<Array<int>>? never = null
	var o = "\\{g == null} \\{never == null}"
	g = [["a", "b"], ["c"]]
	if g != null {
		o = o + " \\{g.length}"
	}
	g = [["d"]]
	const Array<Array<string>> fb = [["q"]]
	const h = g ?? fb
	o = o + " \\{h.length}"
	Console.write_line(o)
}
`;
		await build_and_check_output(input, "nullable_array_nested", "true true 2 1", true, opts);
	});

	test("at_or_null on a nested array returns a nullable row", async () => {
		const input = `import System
mv struct Rec {
	mv string name
}
pub func main = () {
	const r = [[1, 2], [3]]
	const s = [["a", "b"], ["c"]]
	const q = [[Rec("x")], [Rec("y"), Rec("z")]]
	var o = ""
	const x = r.at_or_null(1)
	if x != null {
		o = o + "\\{x.length}"
	}
	if r.at_or_null(5) == null {
		o = o + " none"
	}
	const sx = s.at_or_null(0)
	if sx != null {
		o = o + " " + sx.at_or(1, "-")
	}
	const qx = q.at_or_null(1)
	if qx != null {
		o = o + " \\{qx.length}"
	}
	const z = r.at_or_null(0) ?? [9]
	const w = r.at_or_null(7) ?? [9, 9, 9]
	const qy = q.at_or_null(9) ?? [Rec("f")]
	Console.write_line(o + " \\{z.length} \\{w.length} \\{qy.length}")
}
`;
		await build_and_check_output(input, "nested_at_or_null", "1 none b 2 2 3 1", true, opts);
	});

	test("a nullable array cannot be used as a plain one", () => {
		const parsed = parse_with_imports(`var Array<int>? a = [1]
const Array<int> b = mv a`);
		expect(parsed.errors.map((e) => e.message)).toEqual([
			"Type mismatch in declaration: Array<int>? (expected Array<int>)",
		]);
	});

	test("a null array may not be read", () => {
		const parsed = parse_with_imports(`var Array<int>? a = null
const n = a.length`);
		expect(parsed.errors.map((e) => e.message)).toEqual(["Variable 'a' may be null"]);
	});

	test("the ?? fallback must be the same array type", () => {
		const parsed = parse_with_imports(`var Array<int>? a = null
const Array<string> s = ["a"]
const t = a ?? s`);
		expect(parsed.errors.map((e) => e.message)).toEqual([
			"Type mismatch in '??' fallback: Array<string> (expected Array<int>)",
		]);
	});

	test("?. reads a member of a nullable array", async () => {
		const input = `import System
mv struct Bag {
	var Array<string>? names
}

func size = (Array<int>? xs, out int) {
	return xs?.length ?? -1
}

pub func main = () {
	var Array<int>? a = null
	var o = "\\{a?.length ?? -1} \\{a?.at_or(1, 0) ?? -1} \\{a?.length == null}"
	a = [4, 5, 6]
	o = o + " \\{a?.length ?? -1} \\{a?.at_or(1, 0) ?? -1} \\{a?.length == null}"
	const n = a?.length
	o = o + " \\{n ?? 0} \\{size(null)} \\{size([1, 2])}"
	var b = Bag(null)
	o = o + " \\{b.names?.length ?? 0}"
	b.names = ["x", "y"]
	o = o + " \\{b.names?.at_or(1, "-") ?? "none"}"
	Console.write_line(o)
}
`;
		await build_and_check_output(
			input,
			"nullable_array_chain",
			"-1 -1 true 3 5 false 3 -1 2 0 y",
			true,
			opts,
		);
	});

	test("?. through a nullable struct to its nullable array field", async () => {
		const input = `import System
mv struct Bag {
	var Array<int>? xs
}
func find = (int id, out Bag?) {
	if id == 1 {
		return Bag([1, 2, 3])
	}
	return null
}
pub func main = () {
	var p = find(1)
	var q = find(2)
	var r = find(1)
	if r != null {
		r.xs = null
	}
	Console.write_line("\\{p?.xs?.length ?? -1} \\{q?.xs?.length ?? -1} \\{r?.xs?.length ?? -1} \\{p?.xs?.at_or(1, 0) ?? -1}")
}
`;
		await build_and_check_output(input, "nullable_array_chain_field", "3 -1 -1 2", true, opts);
	});

	test("?. yields owned and borrowed arrays", async () => {
		const input = `import System
mv struct Bag {
	var Array<int>? xs
}
func find = (int id, out Bag?) {
	if id == 1 {
		return Bag([1, 2, 3])
	}
	return null
}
func total = (Array<int>? xs, out int) {
	if xs == null {
		return -1
	}
	var t = 0
	for x of xs {
		t = t + x
	}
	return t
}
pub func main = () {
	var Array<int>? a = null
	const c0 = a?.copy()
	a = [4, 5]
	const c1 = a?.copy()
	var p = find(1)
	var q = find(2)
	const px = p?.xs
	const qx = q?.xs
	var Array<Array<int>>? g = null
	const r0 = g?.at(0)
	g = [[1, 2], [3, 4, 5]]
	const r1 = g?.at(1)
	Console.write_line("\\{c0 == null} \\{total(c1)} \\{total(px)} \\{qx == null} \\{r0 == null} \\{total(r1)} \\{total(a?.copy())} \\{total(p?.xs)}")
}
`;
		await build_and_check_output(
			input,
			"nullable_array_chain_arrays",
			"true 9 6 true true 12 9 6",
			true,
			opts,
		);
	});

	test("an owned ?. array can be stored", async () => {
		const input = `import System
pub func main = () {
	var Array<int>? a = [1, 2]
	var Array<int>? y = null
	y = a?.copy()
	Console.write_line("\\{y?.length ?? -1}")
}
`;
		await build_and_check_output(input, "nullable_array_chain_store", "2", true, opts);
	});

	test("a borrowed ?. array must be const", () => {
		const parsed = parse_with_imports(`mv struct Bag {
	var Array<int>? xs
}
var Bag? p = null
var px = p?.xs`);
		expect(parsed.errors.map((e) => e.message)).toEqual([
			"'px' borrows its array from '?.' — declare it with 'const', or end the chain with '?.copy()'",
		]);
	});
});

// Storing into an owned heap `Array<T>` local frees the displaced buffer.
describe("heap array reassignment", () => {
	test("copies, with and literals replace the buffer", async () => {
		const input = `import System
mv struct Rec {
	mv string name
}
pub func main = () {
	var Array<int> x = [9]
	const Array<int> y = [1, 2, 3]
	var o = "\\{x.length} "
	x = y.copy()
	o = o + "\\{x.length} "
	x = Array<int>.with(0, 2)
	o = o + "\\{x.length} "
	x = [4, 5, 6, 7]
	var Array<Rec> r = [Rec("a")]
	r = [Rec("b"), Rec("c")]
	Console.write_line(o + "\\{x.length} \\{x.at_or(3, 0)} \\{r.length}")
}
`;
		await build_and_check_output(input, "heap_array_reassign", "1 3 2 4 7 2", true, opts);
	});

	test("mv transfers a buffer into a local", async () => {
		const input = `import System
pub func main = () {
	var Array<string> x = ["a"]
	var Array<string> y = ["b", "c"]
	x = mv y
	var Array<string>? n = null
	var Array<string> z = ["d", "e", "f"]
	n = mv z
	var o = "\\{x.length}"
	if n != null {
		o = o + " \\{n.length}"
	}
	Console.write_line(o)
}
`;
		await build_and_check_output(input, "heap_array_mv_reassign", "2 3", true, opts);
	});

	test("storing another array's buffer is rejected", () => {
		const parsed = parse_with_imports(`var Array<int> x = [1]
const Array<int> y = [2]
x = y`);
		expect(parsed.errors.map((e) => e.message)).toEqual([
			"Storing 'y' in the Array<T> variable 'x' would share its buffer --> transfer it with `mv y`, or store a copy (`y.copy()`)",
		]);
	});
});
