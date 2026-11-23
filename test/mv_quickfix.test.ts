import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import type QuickFix from "../src/check/utils/QuickFix.ts";
import { get_library } from "../src/lib";
import parse from "../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

/** Parse `source`, find the first diagnostic carrying a quick fix, apply its
 *  edit, and re-parse. Mirrors the extension's consumption (match by
 *  message + start, apply insert or replace) — test/field_effects_quickfix.ts
 *  pins the same contract for the declared-effect fixes. `needle` selects the
 *  edited line to assert on. */
function apply_first_quick_fix(
	source: string,
	needle: string,
): {
	fix: QuickFix;
	signature: string;
	errors: string[];
} {
	const first = parse(source, system, "/tmp/probe.nomen", {
		allow_internal: true,
		allow_user_raw: true,
	});
	const diag = [...first.errors, ...first.warnings].find((d) => !!d.quick_fix);
	expect(diag, "expected a diagnostic carrying a quick fix").toBeDefined();
	const fix = diag!.quick_fix!;
	const edited =
		fix.insert_offset !== undefined
			? source.slice(0, fix.insert_offset) + fix.insert_text + source.slice(fix.insert_offset)
			: source.slice(0, fix.replace_start!) + fix.replace_text! + source.slice(fix.replace_end!);
	const second = parse(edited, system, "/tmp/probe.nomen", {
		allow_internal: true,
		allow_user_raw: true,
	});
	const signature = edited
		.split("\n")
		.find((l) => l.includes(needle))
		?.trim();
	expect(signature, `the edited source lost the line containing ${needle}`).toBeDefined();
	return {
		fix,
		signature: signature!,
		errors: second.errors.map((e) => e.message),
	};
}

describe("ownership-spelling quick fixes", () => {
	test("field requirement: `var` rewrites to `mv`", () => {
		const result = apply_first_quick_fix(
			`
mv struct Holder {
	var string name
}
`,
			"string name",
		);
		expect(result.fix.title).toBe("Declare it 'mv string name'");
		expect(result.signature).toBe("mv string name");
		expect(result.errors).toEqual([]);
	});

	test("field requirement behind a visibility prefix", () => {
		const result = apply_first_quick_fix(
			`
mv struct Holder {
	pub var string name
}
`,
			"pub mv string name",
		);
		// keyword_start is stamped after the visibility prefix, so the
		// replace lands on `var`, not `pub`.
		expect(result.signature).toBe("pub mv string name");
		expect(result.errors).toEqual([]);
	});

	test("store requirement: `mv ` inserted before the donor", () => {
		const result = apply_first_quick_fix(
			`
import System
mv struct Holder {
	mv string name
}
var h = Holder("x")
var n = "alice"
h.name = n
`,
			"h.name = mv n",
		);
		expect(result.fix.title).toBe("Insert 'mv' — write 'name = mv n'");
		expect(result.signature).toBe("h.name = mv n");
		expect(result.errors).toEqual([]);
	});

	test("fresh initializer: `mv` rewrites to `var`", () => {
		const result = apply_first_quick_fix(
			`
mv n = "bob"
`,
			"var n = ",
		);
		expect(result.fix.title).toBe("Use `var`");
		expect(result.signature).toBe('var n = "bob"');
		expect(result.errors).toEqual([]);
	});

	test("fresh initializer through the `var mv` canonical rewrite", () => {
		const result = apply_first_quick_fix(
			`
var mv n = "bob"
`,
			"var n = ",
		);
		// The parser rewrites this shape to `mv n = …` with keyword_text
		// "var" — the replace span must cover both keywords, or the edit
		// leaves `mv n = …` and the error survives.
		expect(result.signature).toBe('var n = "bob"');
		expect(result.errors).toEqual([]);
	});
});
