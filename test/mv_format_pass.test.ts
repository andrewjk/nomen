import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { apply_ownership_spellings } from "../src/format_ownership";
import { get_library } from "../src/lib";
import parse from "../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

/** A source whose only diagnostics are the ownership spellings. */
function clean(source: string): boolean {
	return parse(source, system, "/tmp/probe.nomen", {
		allow_internal: true,
		allow_user_raw: true,
	}).errors.every((e) => !e.message.includes("mv"));
}

describe("format ownership-spelling pass", () => {
	test("one pass fixes field, store, and fresh shapes together", () => {
		const source = `import System

mv struct Holder {
	var string name
}

var h = Holder("x")
var n = "alice"
h.name = n
mv copy = "spare"
`;
		const result = apply_ownership_spellings(source, { lib: system });
		expect(result.changed).toBe(true);
		expect(result.code).toContain("mv string name");
		expect(result.code).toContain("h.name = mv n");
		expect(result.code).toContain('var copy = "spare"');
		// Converged: a second pass finds nothing.
		const again = apply_ownership_spellings(result.code, { lib: system });
		expect(again.changed).toBe(false);
		// The rewritten source compiles clean (no mv diagnostics).
		const leftover = parse(result.code, system, "/tmp/probe.nomen", {
			allow_internal: true,
			allow_user_raw: true,
		}).errors.filter((e) => e.message.includes("mv"));
		expect(leftover).toEqual([]);
		expect(clean(result.code)).toBe(true);
	});

	test("an already-conforming file is left untouched", () => {
		const source = `import System

mv struct Holder {
	mv string name
}

var h = Holder("x")
var n = "alice"
h.name = mv n
`;
		const result = apply_ownership_spellings(source, { lib: system });
		expect(result.changed).toBe(false);
		expect(result.code).toBe(source);
	});

	test("works without the System library for built-in owners", () => {
		const source = `
mv struct Holder {
	var string name
}
`;
		const result = apply_ownership_spellings(source, {});
		expect(result.changed).toBe(true);
		expect(result.code).toContain("mv string name");
	});
});
