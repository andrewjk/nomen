import path from "node:path";

import { expect, describe, test } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

/** Parse `source` (which must `import System`) with the System library linked. */
function parse_raw(source: string) {
	return parse(source, system);
}

function warning_messages(source: string): string[] {
	return parse_raw(source)
		.warnings.map((w) => w.message)
		.sort();
}

describe("warnings — unused declarations", () => {
	test("unused value warns", () => {
		const input = `
import System
func main = () {
	var x = 5
	Console.write("hi")
}
main()
`;
		expect(warning_messages(input)).toContain("Value 'x' is never used");
	});

	test("used value does not warn", () => {
		const input = `
import System
func main = () {
	var x = 5
	Console.write("\\{x}")
}
main()
`;
		expect(warning_messages(input)).not.toContain("Value 'x' is never used");
	});

	test("unused parameter warns", () => {
		const input = `
import System
func greet = (int n) {
	Console.write("hi")
}
greet(1)
`;
		expect(warning_messages(input)).toContain("Parameter 'n' is never used");
	});

	test("used parameter does not warn", () => {
		const input = `
import System
func add = (int a, int b, out int) {
	return a + b
}
Console.write("\\{add(1, 2)}")
`;
		expect(warning_messages(input)).not.toContain("Parameter 'a' is never used");
		expect(warning_messages(input)).not.toContain("Parameter 'b' is never used");
	});

	test("underscore-prefixed names are not warned", () => {
		const input = `
import System
func f = (int _unused) {
	Console.write("hi")
}
f(1)
`;
		expect(warning_messages(input)).toEqual([]);
	});

	test("main's entry-point params are not flagged", () => {
		const input = `
import System
pub func main = (Init init) {
	Console.write("hi")
}
`;
		expect(warning_messages(input)).not.toContain("Parameter 'init' is never used");
	});

	test("unused private function warns", () => {
		const input = `
import System
func helper = () {
	Console.write("hi")
}
func main = () {
	Console.write("main")
}
main()
`;
		expect(warning_messages(input)).toContain("Function 'helper' is never called");
	});

	test("a called function does not warn", () => {
		const input = `
import System
func helper = () {
	Console.write("hi")
}
func main = () {
	helper()
}
main()
`;
		expect(warning_messages(input)).not.toContain("Function 'helper' is never called");
	});

	test("pub functions are not flagged when unused (public API)", () => {
		const input = `
import System
pub func helper = () {
	Console.write("hi")
}
func main = () {
	Console.write("main")
}
main()
`;
		expect(warning_messages(input)).not.toContain("Function 'helper' is never called");
	});

	test("unused private method on a non-trait struct warns", () => {
		const input = `
import System
struct Counter {
	var int count = 0
	private func unused = () {
		Console.write("nope")
	}
}
var Counter c = Counter()
`;
		expect(warning_messages(input)).toContain("Method 'unused' is never called");
	});
});

describe("warnings — switch/match cases are visible to the analysis", () => {
	test("parameter read in a switch case condition does not warn", () => {
		const input = `
import System
func pick = (bool a, out string) =>
	switch {
		case a -> "yes"
	} else -> "no"
Console.write("\\{pick(true)}")
`;
		expect(warning_messages(input)).not.toContain("Parameter 'a' is never used");
	});

	test("parameter read in a switch case body does not warn", () => {
		const input = `
import System
func pick = (bool a, bool b, out string) {
	switch {
		case b {
			return "b"
		}
	} else {
			return "\\{a}"
		}
}
Console.write("\\{pick(true, false)}")
`;
		expect(warning_messages(input)).not.toContain("Parameter 'a' is never used");
		expect(warning_messages(input)).not.toContain("Parameter 'b' is never used");
	});

	test("function called inside a switch case body does not warn", () => {
		const input = `
import System
func helper = () {
	Console.write("hi")
}
func main = () {
	switch {
		case true {
			helper()
		}
	}
}
main()
`;
		expect(warning_messages(input)).not.toContain("Function 'helper' is never called");
	});

	test("function called inside a match case body does not warn", () => {
		const input = `
import System
func helper = () {
	Console.write("hi")
}
func main = () {
	const x = 1
	match x {
		case 1 {
			helper()
		}
	}
}
main()
`;
		expect(warning_messages(input)).not.toContain("Function 'helper' is never called");
	});
});

describe("warnings — var never changed", () => {
	test("var that is never reassigned warns", () => {
		const input = `
import System
func main = () {
	var x = 5
	Console.write("\\{x}")
}
main()
`;
		expect(warning_messages(input)).toContain(
			"Variable 'x' is never changed, consider using const",
		);
	});

	test("var that is reassigned does not warn", () => {
		const input = `
import System
func main = () {
	var x = 5
	x = 10
	Console.write("\\{x}")
}
main()
`;
		expect(warning_messages(input)).not.toContain(
			"Variable 'x' is never changed, consider using const",
		);
	});

	test("var mutated via compound assignment does not warn", () => {
		const input = `
import System
func main = () {
	var x = 5
	x += 1
	Console.write("\\{x}")
}
main()
`;
		expect(warning_messages(input)).not.toContain(
			"Variable 'x' is never changed, consider using const",
		);
	});

	test("const does not warn about being unchanged", () => {
		const input = `
import System
func main = () {
	const x = 5
	Console.write("\\{x}")
}
main()
`;
		expect(warning_messages(input)).not.toContain(
			"Variable 'x' is never changed, consider using const",
		);
	});
});

describe("warnings — mv on value-struct fields", () => {
	const owning_struct = `
import System

struct Items {
	var List<int> values = List<int>()
}

struct Pair {
	var string a = "x"
}
`;

	test("mv on a mv value-struct field warns", () => {
		const input = `
${owning_struct}
struct Holder {
	pub mv List<int> items = List<int>()
}
`;
		expect(warning_messages(input)).toContain(
			"'mv' on field 'items' is redundant: 'List<int>' is a value struct — its ownership is derived from the type, so plain 'var' behaves identically",
		);
	});

	test("var on a mv value-struct field does not warn", () => {
		const input = `
${owning_struct}
struct Holder {
	pub var List<int> items = List<int>()
}
`;
		expect(warning_messages(input)).not.toContain(
			"'mv' on field 'items' is redundant: 'List<int>' is a value struct — its ownership is derived from the type, so plain 'var' behaves identically",
		);
	});

	test("mv on a mv-typed field warns as redundant (B5)", () => {
		const input = `
import System

mv struct Node {
	var int value
}

mv struct Holder {
	mv Node node = Node(1)
}
`;
		// B5 collapsed the `mv` field spelling: ownership follows the
		// field's TYPE, so the keyword is dead weight and warns.
		expect(
			warning_messages(input).some((m) => m.includes("'mv' on field 'node' is redundant")),
		).toBe(true);
	});

	test("mv on a plain (non-mv) value-struct field does not warn", () => {
		const input = `
${owning_struct}
struct Holder {
	mv Pair pair = Pair()
}
`;
		expect(
			warning_messages(input).filter((m) => m.includes("'mv' on field 'pair' is redundant")),
		).toEqual([]);
	});
});

describe("warnings — redundant type annotations", () => {
	test("annotated constructor initializer warns", () => {
		const input = `
import System
struct Point {
	var int x
	var int y
}
func main = () {
	const Point p = Point(2, 3)
	Console.write("\\{p.x + p.y}")
}
main()
`;
		expect(
			warning_messages(input).some((m) =>
				m.includes("Type annotation on 'p' is redundant — 'Point' is already inferred"),
			),
		).toBe(true);
	});

	test("annotated literal initializer warns", () => {
		const input = `
import System
func main = () {
	var int n = 5
	var string s = "hi"
	Console.write("\\{n}\\{s}")
}
main()
`;
		expect(warning_messages(input)).toContain(
			"Type annotation on 'n' is redundant — 'int' is already inferred; run 'nomen format' to drop it",
		);
		expect(warning_messages(input)).toContain(
			"Type annotation on 's' is redundant — 'string' is already inferred; run 'nomen format' to drop it",
		);
	});

	test("implicit initializers do not warn", () => {
		const input = `
import System
struct Point {
	var int x
	var int y
}
func main = () {
	const p = Point(2, 3)
	var n = 5
	Console.write("\\{p.x + n}")
}
main()
`;
		expect(warning_messages(input).filter((m) => m.includes("is redundant"))).toEqual([]);
	});

	test("a literal that infers a different type does not warn", () => {
		const input = `
import System
func main = () {
	var int16 small = 300
	var float f = 5
	Console.write("\\{small}\\{f}")
}
main()
`;
		expect(warning_messages(input).filter((m) => m.includes("is redundant"))).toEqual([]);
	});

	test("a nullable annotation is not redundant", () => {
		const input = `
import System
func main = () {
	var int? x = null
	Console.write("\\{x == null}")
}
main()
`;
		expect(warning_messages(input).filter((m) => m.includes("is redundant"))).toEqual([]);
	});

	test("a field with an initializer warns", () => {
		const input = `
import System
struct Counter {
	var int count = 0
}
func main = () {
	Console.write("\\{Counter().count}")
}
main()
`;
		expect(warning_messages(input)).toContain(
			"Type annotation on 'count' is redundant — 'int' is already inferred; run 'nomen format' to drop it",
		);
	});

	test("a fully-written generic constructor annotation warns", () => {
		const input = `
import System
struct Box2<T> {
	var T value
}
func main = () {
	var Box2<int> b = Box2<int>(1)
	Console.write("\\{b.value}")
}
main()
`;
		expect(warning_messages(input)).toContain(
			"Type annotation on 'b' is redundant — 'Box2<int>' is already inferred; run 'nomen format' to drop it",
		);
	});

	test("a generic annotation the call relies on does not warn", () => {
		const input = `
import System
struct Box2<T> {
	var T value
}
func main = () {
	var Box2<int> b = Box2(1)
	Console.write("\\{b.value}")
}
main()
`;
		expect(warning_messages(input).filter((m) => m.includes("is redundant"))).toEqual([]);
	});

	test("an enum shorthand initializer does not warn", () => {
		const input = `
import System
enum Direction {
	.east
	.west
}
func main = () {
	var Direction d = .east
	Console.write("\\{d == .east}")
}
main()
`;
		expect(warning_messages(input).filter((m) => m.includes("is redundant"))).toEqual([]);
	});

	test("an array literal initializer does not warn", () => {
		const input = `
import System
func main = () {
	var int[] nums = [1, 2, 3]
	Console.write("\\{nums.length}")
}
main()
`;
		expect(warning_messages(input).filter((m) => m.includes("is redundant"))).toEqual([]);
	});

	test("a constrained declaration does not warn", () => {
		const input = `
import System
func main = () {
	var int x: x > 0 = 5
	Console.write("\\{x}")
}
main()
`;
		expect(warning_messages(input).filter((m) => m.includes("is redundant"))).toEqual([]);
	});

	test("System library internals do not warn", () => {
		const input = `
import System
func main = () {
	Console.write("\\{Regex.count("\\\\d", "a1b2")}")
}
main()
`;
		expect(warning_messages(input).filter((m) => m.includes("is redundant"))).toEqual([]);
	});
});
