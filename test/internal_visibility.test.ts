import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import type CompileError from "../src/types/CompileError";

/**
 * A tiny in-memory library used to exercise `internal` across the
 * user/library boundary. `Widget` is `pub` so user code can construct it and
 * reach the members whose own visibility is under test; `lib_helper` and
 * `use_internals` exercise free functions.
 */
const LIB_SOURCE = `pub struct Widget {
	internal var int secret = 0
	pub var int shown = 0
	internal func hidden = (self, out int) { return self.secret }
	pub func visible = (self, out int) { return self.shown }
}
internal func lib_helper = (out int) { return 7 }
pub func use_internals = (ref Widget w, out int) {
	return w.hidden() + w.secret + lib_helper()
}
`;

const library = {
	name: "Test",
	source: LIB_SOURCE,
	types: new Map([
		["Widget", { name: "Widget", source: LIB_SOURCE, path: "Test/Widget.nm", deps: [] }],
	]),
	functions: new Map([
		["lib_helper", { name: "lib_helper", source: LIB_SOURCE, path: "Test/Widget.nm", deps: [] }],
	]),
	namespaces: new Map<string, Set<string>>(),
	dir: path.resolve("/nonexistent-test-library"),
};

/** Build the expected error by locating `needle` in `source`. */
function at(source: string, needle: string, message: string): CompileError {
	const start = source.indexOf(needle);
	const before = source.slice(0, start);
	const line = before.split("\n").length;
	const column = start - before.lastIndexOf("\n");
	return { message, start, line, column };
}

const system = get_library(path.resolve(import.meta.dirname, "../core"));

describe("internal visibility", () => {
	test("internal item is visible throughout a single-module program", () => {
		const input = `
internal struct Secret {
	var int value = 0
}
internal func helper = (out int) { return 1 }
pub func main = () {
	var Secret s = Secret()
	var int x = helper()
}
`;
		expect(parse(input).errors).toEqual([]);
	});

	test("internal field of a public struct is hidden from user code", () => {
		const input = `import System
pub func main = () {
	var Widget w = Widget()
	var int a = w.secret
}
`;
		expect(parse(input, library).errors).toEqual([
			at(input, "secret", "Can't access internal field: secret"),
		]);
	});

	test("internal method of a public struct is hidden from user code", () => {
		const input = `import System
pub func main = () {
	var Widget w = Widget()
	var int a = w.hidden()
}
`;
		expect(parse(input, library).errors).toEqual([
			at(input, "hidden", "Can't access internal function: hidden"),
		]);
	});

	test("internal free function is hidden from user code", () => {
		const input = `import System
pub func main = () {
	var int a = lib_helper()
}
`;
		expect(parse(input, library).errors).toEqual([
			at(input, "lib_helper", "Can't access internal function: lib_helper"),
		]);
	});

	test("library code may use its own internal members", () => {
		const input = `import System
pub func main = () {
	var Widget w = Widget()
	var int a = w.visible()
}
`;
		expect(parse(input, library).errors).toEqual([]);
	});

	test("allow_internal trusts user code to reach internal members", () => {
		const input = `import System
pub func main = () {
	var Widget w = Widget()
	var int a = w.secret + w.hidden() + lib_helper()
}
`;
		expect(parse(input, library, undefined, { allow_internal: true }).errors).toEqual([]);
	});

	test("internal is rejected on trait members", () => {
		const input = `
trait Broken {
	internal var int x
	internal func y = (self)
}
`;
		expect(parse(input).errors).toEqual([
			at(input, "internal var int x", "Trait fields cannot be internal"),
			at(input, "internal func y", "Trait functions cannot be internal"),
		]);
	});

	test("Buffer is public but its raw primitives stay internal", () => {
		const construct = `import System
pub func main = () {
	var Buffer<int> b = Buffer<int>()
	var int c = b.cap
}
`;
		expect(parse(construct, system).errors).toEqual([]);

		const misuse = `import System
pub func main = () {
	var Buffer<int> b = Buffer<int>()
	b.alloc_int(4)
}
`;
		const errors = parse(misuse, system).errors;
		expect(errors.length).toBe(1);
		expect(errors[0].message).toMatch(/^Can't access internal function: alloc_int/);
	});
});
