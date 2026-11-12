import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("spec: basic types", () => {
	test("sized and unsigned numeric types with literal coercion", () => {
		const input = `
const int16 small = 300
const int doubled = small * 2
const ufloat ratio = 0.5
const ufloat scaled = ratio * 2.0
Console.write("\\{doubled} \\{scaled}\\n")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("negative literals are rejected for unsigned types", () => {
		const input = `
const ufloat ratio = -0.5
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("Type mismatch"))).toBe(true);
	});
});

describe("spec: comments", () => {
	test("single and nested block comments", () => {
		const input = `
// Single-line comment

/* Block comment
   /* nested comments supported */ */
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: array types", () => {
	test("basic array declarations", () => {
		const input = `
const int[] numbers = [1, 2, 3, 4]
const char[] letters = ['a', 'b', 'c']
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("fixed-length array", () => {
		const input = `
const int[10] buffer = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("array length access", () => {
		const input = `
const int[] numbers = [1, 2, 3, 4]
const len = numbers.length
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: Array<T> type", () => {
	test("constructors", () => {
		const input = `
const ints = Array<int>(1, 2, 3)
const Array<string> names = ["a", "b"]
const nums = Array<int>(0, 1, 2)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("static with method", () => {
		const input = `
const zeros = Array.with(0, 3)
const strs = Array<string>.with("x", 2)
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: nullable types", () => {
	test("assigning null to nullable", () => {
		const input = `
var int? x = null
var string? name = null
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("nullable initialized with value", () => {
		const input = `
var int? x = 5
const y = x + 1
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("assigning null to non-nullable is an error", () => {
		const input = `
const int x = null
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("null"))).toBe(true);
	});

	test("using a null variable is an error", () => {
		const input = `
var int? x = null
const y = x + 1
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("null"))).toBe(true);
	});
});

describe("spec: reference types", () => {
	test("ref type declarations", () => {
		const input = `
struct Character { var int code }
struct Node { var int value }
func takeRef = (ref int x) { var int y = x }
func takeRefNode = (ref Node? n) { var z = 0 }
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("reference parameters", () => {
		const input = `
func makeFive = (ref int x) {
    x = 5
}
var num = 1
makeFive(ref num)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("calling without ref is an error", () => {
		const input = `
func makeFive = (ref int x) {
    x = 5
}
var num = 1
makeFive(num)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("ref"))).toBe(true);
	});

	test("ref for non-ref parameter is an error", () => {
		const input = `
func print = (int x) {}
print(ref 5)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("ref"))).toBe(true);
	});

	test("const value cannot be passed to ref parameter", () => {
		const input = `
func makeFive = (ref int x) {
    x = 5
}
const fixed = 1
makeFive(ref fixed)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("const"))).toBe(true);
	});

	test("var value can be passed to ref parameter", () => {
		const input = `
func makeFive = (ref int x) {
    x = 5
}
var mutable = 1
makeFive(ref mutable)
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: declared field effects", () => {
	const PROGRAM = `
mv struct Stats {
    var int hits
}

mv struct Item {
    var int weight
    var Box<Stats> stats
}

func rebalance = (ref Item item { stats }) {
    item.stats = mv Box<Stats>(mv Stats(0))
}

func touch = (ref Item item {}, int by) {
    item.weight = item.weight + by
}

pub func main = () {
    var item = Item(1, mv Box<Stats>(mv Stats(2)))
    var s = item.stats
    touch(ref item, 1)
    Console.write("\\{s.hits}")
}
`;

	test("the declared set keeps sibling-field borrows alive", () => {
		const clean = PROGRAM.replace("    rebalance(ref item)\n", "");
		expect(compile_module(clean)).toEqual([]);
	});

	test("a declared mutator invalidates exactly its fields", () => {
		const with_call = PROGRAM.replace(
			`    touch(ref item, 1)\n`,
			`    touch(ref item, 1)\n    rebalance(ref item)\n`,
		);
		const errors = compile_module(with_call);
		expect(errors.some((e) => e.message.includes("was invalidated"))).toBe(true);
	});

	test("writing an undeclared field is an error", () => {
		const input = `
mv struct Stats {
    var int hits
}

mv struct Item {
    var Box<Stats> stats
}

func bad = (ref Item item {}) {
    item.stats = mv Box<Stats>(mv Stats(0))
}

pub func main = () {}
`;
		const errors = compile_module(input);
		expect(
			errors.some((e) =>
				e.message.includes("'bad' declares an empty field set, but the body writes item.stats"),
			),
		).toBe(true);
	});

	test("a field set is only allowed on ref parameters", () => {
		const input = `
mv struct Stats {
    var int hits
}

func bad = (Stats item { hits }) {}

pub func main = () {}
`;
		const errors = compile_module(input);
		expect(
			errors.some((e) => e.message.includes("a field set is only allowed on a 'ref' parameter")),
		).toBe(true);
	});

	test("a field set on bare self is rejected", () => {
		const input = `
mv struct Item {
    var int weight

    func bad = (self { weight }) {}
}

pub func main = () {}
`;
		const errors = compile_module(input);
		expect(errors.some((e) => e.message.includes("bare 'self' is a read-only receiver"))).toBe(
			true,
		);
	});

	test("an un-annotated ref parameter is a wildcard (whole-owner invalidation)", () => {
		const input = `
mv struct Stats {
    var int hits
}

mv struct Item {
    var int weight
    var Box<Stats> stats
}

func touch = (ref Item item, int by) {
    item.weight = item.weight + by
}

pub func main = () {
    var item = Item(1, mv Box<Stats>(mv Stats(2)))
    var s = item.stats
    touch(ref item, 1)
    Console.write("\\{s.hits}")
}
`;
		const errors = compile_module(input);
		expect(errors.some((e) => e.message.includes("was invalidated"))).toBe(true);
	});

	test("a trait's declared set binds conformers (subset ok, widening rejected)", () => {
		const ok = `
mv struct Stats {
    var int hits
}

trait Holderish {
    func rebalance = (ref self { stats })
}

mv struct H: Holderish {
    var Box<Stats> stats

    func rebalance = (ref self { stats }) {
        self.stats = mv Box<Stats>(mv Stats(0))
    }
}

pub func main = () {}
`;
		expect(compile_module(ok)).toEqual([]);

		const widened = `
mv struct Stats {
    var int hits
}

trait Holderish {
    func rebalance = (ref self { stats })
}

mv struct H: Holderish {
    var Box<Stats> stats
    var int weight

    func rebalance = (ref self { stats, weight }) {
        self.stats = mv Box<Stats>(mv Stats(0))
        self.weight = 0
    }
}

pub func main = () {}
`;
		const errors = compile_module(widened);
		expect(errors.some((e) => e.message.includes("widens the trait's field set"))).toBe(true);
	});
});

describe("spec: range types", () => {
	test("range expression", () => {
		const input = `
const range = 0..10
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: nullable chaining", () => {
	test("chains consume through ?? and null tests", () => {
		const input = `
struct Profile {
	var int score
}

func find = (int id, out Profile?) {
	if id == 1 {
		return Profile(7)
	}
	return null
}

func describe = (int id, out string) {
	var p = find(id)
	if p?.score != null {
		return "found"
	}
	return "missing"
}

func score_or = (int id, out int) {
	var p = find(id)
	return p?.score ?? 0
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
