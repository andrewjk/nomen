import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import check_output from "./check_output";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

function check_program(source: string) {
	const parsed = parse(source, system, undefined, { allow_internal: true });
	return { errors: parsed.errors, warnings: parsed.warnings ?? [] };
}

describe("module-level const declared below first use", () => {
	test("check: function using a const declared later in the file", () => {
		const result = check_program(`
import System

pub func main = () {
	Console.write_line(LATE)
}

pub const LATE = "hello"
`);
		expect(result.errors).toEqual([]);
	});

	test("check: method using a const declared later in the file", () => {
		const result = check_program(`
import System

struct Greeter {
	pub func greet = (out string) {
		return GREETING
	}
}

pub const GREETING = "hello"

pub func main = () {
	var Greeter g = Greeter()
	Console.write_line(g.greet())
}
`);
		expect(result.errors).toEqual([]);
	});

	test("check: composed-string const declared later in the file", () => {
		const result = check_program(`
import System

pub func main = () {
	Console.write_line(LATE_COMPOSED)
}

pub const LATE_A = "hel"
pub const LATE_COMPOSED = LATE_A + "lo"
`);
		expect(result.errors).toEqual([]);
	});

	test("run: composed-string const used before declaration (both backends)", async () => {
		// Note: int const op-chains (`pub const N = 3 + 4`) at module level are
		// a pre-existing separate gap on aarch64 — the emitter reserves the
		// global's storage but cannot lower a non-literal initializer into the
		// data section (see FOLLOWUP.md). The recorded bug here is the CHECK
		// failure for string consts, which build and run correctly in both
		// declaration orders.
		const source = `
import System

pub func main = () {
	Console.write_line(LATE_COMPOSED)
	Console.write_line(FEET)
}

pub const LATE_A = "hel"
pub const LATE_COMPOSED = LATE_A + "lo"
pub const FEET = "two"
`;
		for (const arch of ["c", "aarch64"] as const) {
			const parsed = parse(source, system, undefined, { allow_internal: true });
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch, audit: false });
			await check_output(`const_below_use_${arch}`, result, "hello\ntwo\n", {
				arch,
				audit: false,
			});
		}
	});
});
