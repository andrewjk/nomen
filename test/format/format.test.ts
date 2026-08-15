import { expect, test } from "vite-plus/test";

import format, { format_source } from "../../src/format.ts";

test("strips redundant constructor and literal types", () => {
	// Non-generic constructor form.
	expect(format("var Text title = Text(win)\n")).toBe("var title = Text(win)\n");
	// Literals are stripped only when the declared type equals the inferred type.
	expect(format('var string name = "Andrew"\n')).toBe('var name = "Andrew"\n');
	expect(format("var int x = 5\n")).toBe("var x = 5\n");
	expect(format("var float pi = 3.14\n")).toBe("var pi = 3.14\n");
	expect(format("var bool ok = true\n")).toBe("var ok = true\n");
	// `uint` is kept: the literal `0` infers `int`, not `uint`.
	expect(format("var uint size = 0\n")).toBe("var uint size = 0\n");
	// `int8` is kept: declared type differs from the inferred `int`.
	expect(format("var int8 b = 5\n")).toBe("var int8 b = 5\n");
	// Enum shorthand must keep its type.
	expect(format("var Direction d = .east\n")).toBe("var Direction d = .east\n");
	// Generic constructor calls (concrete or not) do not infer, so the type stays.
	expect(format("var Buffer<T> items = Buffer<T>()\n")).toBe("var Buffer<T> items = Buffer<T>()\n");
	expect(format("var Map<int, int> keys = Map<int, int>()\n")).toBe(
		"var Map<int, int> keys = Map<int, int>()\n",
	);
});

test("strips a declared type when the literal infers exactly it", () => {
	// An integer literal infers `int`, so only `int` matches.
	expect(format("var int x = 5\n")).toBe("var x = 5\n");
	expect(format("var int count = 42\n")).toBe("var count = 42\n");
	// `uint` is kept: the inferred `int` does not match `uint`.
	expect(format("var uint y = 12\n")).toBe("var uint y = 12\n");
	expect(format("var uint z = 0\n")).toBe("var uint z = 0\n");
	// Other sized integer types are likewise kept.
	expect(format("var int8 a = 5\n")).toBe("var int8 a = 5\n");
	expect(format("var int64 b = 5\n")).toBe("var int64 b = 5\n");
	expect(format("var uint16 c = 7\n")).toBe("var uint16 c = 7\n");
	// A float literal infers `float` and matches, but an int literal does not.
	expect(format("var float pi = 3.14\n")).toBe("var pi = 3.14\n");
	expect(format("var float f = 5\n")).toBe("var float f = 5\n");
	// An int literal does not infer `float` even when written with a trailing dot.
	expect(format("var int n = 5.0\n")).toBe("var int n = 5.0\n");
});

test("reindents from spaces to tabs by default", () => {
	const source = "func f = () {\n    if true {\n        return 1\n    }\n}\n";
	const expected = "func f = () {\n\tif true {\n\t\treturn 1\n\t}\n}\n";
	expect(format(source)).toBe(expected);
});

test("uses spaces when use_tabs is false", () => {
	const source = "func f = () {\n    return 1\n}\n";
	const expected = "func f = () {\n    return 1\n}\n";
	expect(format(source, { use_tabs: false })).toBe(expected);
});

test("sorts runs of imports", () => {
	const source = "import System/Controls\nimport System/Collections/List\n";
	const expected = "import System/Collections/List\nimport System/Controls\n";
	expect(format(source)).toBe(expected);
	// When disabled, the order is preserved.
	expect(format(source, { sort_imports: false })).toBe(source);
});

test("wraps an argument list past the print width", () => {
	const source =
		"func f = (int aaaaaaaaa, int bbbbbbbbbb, int cccccccccc, int dddddddddd, int eeeeeeeeee) {}\n";
	const result = format(source, { print_width: 40 });
	expect(result.split("\n").length).toBeGreaterThan(2);
	// And it is idempotent.
	expect(format(result, { print_width: 40 })).toBe(result);
});

test("reflows a long single-line signature onto one parameter per line", () => {
	const source =
		"func f = (int aaaaaaaaaa, int bbbbbbbbbb, int cccccccccc, int dddddddddd, int eeeeeeeeee, int ffffffffff) {\n\treturn 1\n}\n";
	const expected =
		"func f = (\n" +
		"\tint aaaaaaaaaa,\n" +
		"\tint bbbbbbbbbb,\n" +
		"\tint cccccccccc,\n" +
		"\tint dddddddddd,\n" +
		"\tint eeeeeeeeee,\n" +
		"\tint ffffffffff\n" +
		") {\n\treturn 1\n}\n";
	expect(format(source)).toBe(expected);
	// A parameter list is not a list context, so no trailing comma is added —
	// and the reflow is idempotent.
	expect(format(expected)).toBe(expected);
});

test("keeps a generic-typed parameter whole when reflowing", () => {
	const source =
		"func f = (ref Map<string, List<int>> table_data, int another_parameter_here_ok, bool flag) {\n\treturn 1\n}\n";
	const result = format(source, { print_width: 60 });
	// The commas inside `<...>` type arguments are not separators: the
	// parameter stays on one line, written as tightly as the source had it.
	expect(result).toBe(
		"func f = (\n" +
			"\tref Map<string, List<int>> table_data,\n" +
			"\tint another_parameter_here_ok,\n" +
			"\tbool flag\n" +
			") {\n\treturn 1\n}\n",
	);
	expect(format(result, { print_width: 60 })).toBe(result);
});

test("still splits on commas after an unclosed angle bracket", () => {
	// The `<` never closes, so it was a comparison — every comma separates.
	const source = "check_limits(alpha < beta, gamma, delta, epsilon_very_long_name)\n";
	const result = format(source, { print_width: 50 });
	expect(result).toBe(
		"check_limits(\n\talpha < beta,\n\tgamma,\n\tdelta,\n\tepsilon_very_long_name,\n)\n",
	);
});

test("keeps a generic constructor argument whole when wrapping a call", () => {
	const source = "process(Map<int, string>(source_items, capacity_limit), another_argument)\n";
	const result = format(source, { print_width: 60 });
	expect(result).toBe(
		"process(\n\tMap<int, string>(source_items, capacity_limit),\n\tanother_argument,\n)\n",
	);
});

test("leaves raw blocks and multiline strings untouched", () => {
	const source = 'func f = () {\n\t```\nline  one\n  line  two\n```\n\tvar s = "a\n  b"\n}\n';
	const expected = 'func f = () {\n\t```\nline  one\n  line  two\n```\n\tvar s = "a\n  b"\n}\n';
	expect(format(source)).toBe(expected);
});

test("reports no change when already formatted", () => {
	const source = "func f = () {\n\treturn 1\n}\n";
	const result = format_source(source);
	expect(result.changed).toBe(false);
	expect(result.unsafe).toBeUndefined();
});

test("abandons formatting when it would change the tokens", () => {
	// `a -1` vs `a - 1`: a spacing slip would flip the sign onto the number, so
	// the formatter must refuse rather than risk changing the program.
	const source = "func f = (int a) {\n\treturn a -1\n}\n";
	const result = format_source(source);
	expect(result.unsafe).toBeDefined();
	expect(result.code).toBe(source);
});
