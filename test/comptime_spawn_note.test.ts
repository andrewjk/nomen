import { expect, test } from "vite-plus/test";

import render_errors from "../cli/src/format_errors.ts";
import { compile_module } from "./spec/_helpers.ts";

// Two-location diagnostics (R7 follow-up): an error raised anywhere in a
// `#for` expansion's generated code carries `spawned_at` (+ resolved
// `spawned_line`/`spawned_column`) pointing at the generating loop, so the
// position inside the arm is recognizable as generated code.

const program = `
	struct S {
		var x = 0
	}
	func f = () {
		#for field of META.info(S).fields {
			not_a_function()
		}
	}
`;

test("an error inside a #for arm names the generating loop", () => {
	const errors = compile_module(program);
	expect(errors.length).toBeGreaterThan(0);
	const decorated = errors.find((e) => e.spawned_at !== undefined);
	expect(decorated).toBeDefined();
	// The note resolves to the `#for` statement's line in the joined source.
	const joined = "import System\n" + program;
	const for_line = joined.split("\n").findIndex((l) => l.includes("#for field")) + 1;
	expect(decorated?.spawned_line).toBe(for_line);
	expect(decorated?.spawned_column).toBeGreaterThan(0);
});

test("an error outside generated code carries no note", () => {
	const errors = compile_module(`
		func g = () {
			also_not_a_function()
		}
	`);
	expect(errors.length).toBeGreaterThan(0);
	expect(errors.every((e) => e.spawned_at === undefined)).toBe(true);
});

test("the CLI renders a spawned-by note under the primary location", () => {
	const errors = compile_module(program);
	const decorated = errors.find((e) => e.spawned_at !== undefined);
	expect(decorated).toBeDefined();
	const joined = "import System\n" + program;
	const rendered = render_errors(joined, errors);
	expect(rendered).toMatch(/note: spawned by '#for' at .*:\d+:\d+/);
});
