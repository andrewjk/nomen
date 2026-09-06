import fs from "node:fs";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import build, { build_needs_objc, default_platform } from "../src/build";
import { set_move_on_last_use_enabled } from "../src/check/utils/last_use";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import check_output from "./check_output";
import {
	SYSTEM_OBJ,
	SYSTEM_OBJ_A64,
	load_system_fn_names,
	load_system_struct_names,
} from "./system_lib";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

/** Parse + check a FULL program (import System, main, …) and build it for one
 *  arch. Returns the code of main's section only (library code shares the
 *  file, so whole-file counts would be meaningless). */
function build_main(input: string, arch: "aarch64" | "c"): string {
	const parsed = parse(input, system);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch, audit: false });
	expect(result.errors ?? []).toEqual([]);
	if (arch === "c") {
		const start = result.code.indexOf("int main()");
		return result.code.slice(start, result.code.indexOf("// Func", start + 8));
	}
	const lines = result.code.split("\n");
	const start = lines.findIndex((l) => l === "_main:");
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^[A-Za-z_][A-Za-z0-9_]*:$/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n");
}

/** Compile + run a full program on BOTH backends and pin its stdout. */
async function run_program(input: string, name: string, expected: string) {
	const parsed = parse(input, system);
	expect(parsed.errors).toEqual([]);
	const split_available = (arch: "aarch64" | "c") =>
		!build_needs_objc(parsed.root, default_platform()) &&
		(arch === "aarch64" ? fs.existsSync(SYSTEM_OBJ_A64) : fs.existsSync(SYSTEM_OBJ));
	for (const arch of ["aarch64", "c"] as const) {
		const options = { arch, audit: true };
		const split = split_available(arch);
		const result = split
			? build(parsed.root, {
					...options,
					emit_mode: "user",
					system_struct_names: load_system_struct_names(),
				})
			: build(parsed.root, options);
		await check_output(name, result, expected, {
			...options,
			system_lib: split,
			system_fn_names: load_system_fn_names(),
		});
	}
}

function count(code: string, needle: string): number {
	return code.split(needle).length - 1;
}

/**
 * Move-on-last-use declares (STRING_PLAN tranche 4): `var u = t` where t is
 * an owned string local proven never read or written after — the strdup'd
 * value-semantics copy becomes a pair + ownership transfer. The last-use
 * verdicts themselves are pinned in last_use_analysis.test.ts; these pins
 * cover the EMISSION: the transfer, the single-owner free, and the
 * kill-switch restoration.
 */

test("declare move transfers ownership; exactly one free at exit", async () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	var u = t
	Console.write(u)
}
`;
	await run_program(input, "move_on_last_use_basic", "aaaa");

	const c = build_main(input, "c");
	expect(c).toContain("nomen_string u = t;");
	expect(c).not.toContain("nomen_str_dup(");
	expect(count(c, "free(")).toBe(1);

	const a64 = build_main(input, "aarch64");
	// t's declaration strdup's via string_to_string; the alias adds none.
	expect(count(a64, "bl string_to_string")).toBe(1);
	expect(count(a64, "bl _strdup")).toBe(0);
	expect(count(a64, "bl _free")).toBe(1);
});

test("read-after refuses the move (copy stays)", async () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	var u = t
	Console.write(u)
	Console.write(t)
}
`;
	await run_program(input, "move_on_last_use_refused_read", "aaaaaaaa");

	const c = build_main(input, "c");
	expect(c).toContain("nomen_str_dup(t)");
	expect(count(c, "free(")).toBe(2);
});

test("write-after refuses the move (the aliasing UAF shape)", async () => {
	// `a` is written after the alias: transferring ownership would leave `b`
	// aliasing freed/rebound storage.
	const input = `
import System

pub func main = () {
	var string a = 42.to_string()
	var string b = a
	a = "literal"
	Console.write(b)
}
`;
	await run_program(input, "move_on_last_use_refused_write", "42");

	const c = build_main(input, "c");
	expect(c).toContain("nomen_str_dup(a)");
});

test("kill-switch off restores the strdup'd copy", () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	var u = t
	Console.write(u)
}
`;
	const on_c = build_main(input, "c");
	expect(on_c).toContain("nomen_string u = t;");

	let off_c = "";
	let off_a64 = "";
	set_move_on_last_use_enabled(false);
	try {
		off_c = build_main(input, "c");
		off_a64 = build_main(input, "aarch64");
	} finally {
		set_move_on_last_use_enabled(true);
	}
	expect(off_c).toContain("nomen_string u = nomen_str_dup(t);");
	expect(count(off_c, "free(")).toBe(2);
	expect(count(off_a64, "bl _strdup")).toBe(1);
	expect(count(off_a64, "bl _free")).toBe(2);
});
