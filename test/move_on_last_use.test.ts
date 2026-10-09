import fs from "node:fs";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import build, { build_needs_objc, default_platform } from "../src/build";
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
		// The section ends at the next function comment — or at the first
		// memory-foreign adapter (core unsafe bodies emit foreign_free/malloc
		// calls and their adapters, which would otherwise pollute counts).
		let end = result.code.indexOf("// Func", start + 8);
		for (const marker of [
			"nomen_string foreign_",
			"void foreign_",
			"unsigned long long foreign_",
		]) {
			const m = result.code.indexOf(marker, start + 8);
			if (m !== -1 && (end === -1 || m < end)) end = m;
		}
		return result.code.slice(start, end === -1 ? undefined : end);
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
 * Count occurrences inside MAIN's body only. Core unsafe bodies now emit
 * `foreign_free(...)` calls (and the foreign adapter itself contains
 * `free(`), so whole-TU free counts include legitimate library noise the
 * mv-on-last-use pins were never about.
 */
function count_in_main(code: string, needle: string): number {
	const start = code.indexOf("// Func main");
	if (start === -1) return count(code, needle);
	const rest = code.slice(start);
	const end = rest.indexOf("\n}\n");
	const body = (end === -1 ? rest : rest.slice(0, end)).split("foreign_free(").join("externFREE(");
	return body.split(needle).length - 1;
}

/**
 * Explicit string mv (D3): `mv u = t` transfers the owned pair — the
 * donor's scope-exit free is suppressed and the assignee frees once. The
 * retired last-use inference (which silently turned a `var u = t` copy into
 * a transfer) is gone: the mv is now spelled. The independent alternative
 * is `var u = t.copy()`. Kill-switch tests that only exercised the retired
 * inference are skipped below.
 */

test("declare mv is sound on both backends (C transfers, aarch64 copies)", async () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	mv u = t
	Console.write(u)
}
`;
	await run_program(input, "move_on_last_use_basic", "aaaa");

	const c = build_main(input, "c");
	expect(c).toContain("nomen_string u = t;");
	expect(c).not.toContain("nomen_str_dup(");
	expect(count_in_main(c, "free(")).toBe(1);

	const a64 = build_main(input, "aarch64");
	// t's declaration strdup's via string_to_string. The aarch64 declaration
	// path does not yet lower an explicit `mv u = t` to a pair transfer: it
	// takes the heap-alias copy path (strdup + free both), which is sound but
	// not a mv — the C backend transfers (`u = t`, one free). Both shapes
	// are audit-clean; the counts pin the real emission per backend.
	expect(count(a64, "bl string_to_string")).toBe(1);
	expect(count(a64, "bl _strdup")).toBe(1);
	expect(count(a64, "bl _free")).toBe(2);
});

test("read-after demands an explicit copy", async () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	var u = t.copy()
	Console.write(u)
	Console.write(t)
}
`;
	await run_program(input, "move_on_last_use_refused_read", "aaaaaaaa");

	const c = build_main(input, "c");
	expect(c).toContain("string_copy(t)");
	expect(count_in_main(c, "free(")).toBe(2);
});

test("write-after demands an explicit copy (the aliasing UAF shape)", async () => {
	// A copied `b` stays valid when `a` is rebound: the copy owns its own
	// bytes instead of aliasing `a`'s storage.
	const input = `
import System

pub func main = () {
	var string a = 42.to_string()
	var string b = a.copy()
	a = "literal"
	Console.write(b)
}
`;
	await run_program(input, "move_on_last_use_refused_write", "42");

	const c = build_main(input, "c");
	expect(c).toContain("string_copy(a)");
});

test.skip("kill-switch off restores the strdup'd copy", () => {
	// Retired by D3 (explicit mv required): the kill switch controlled the
	// last-use inference that silently rewrote `var u = t`. Bindings now
	// require an explicit `mv`/`.copy()`, so there is nothing to toggle.
});
