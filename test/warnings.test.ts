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
