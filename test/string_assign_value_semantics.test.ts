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

/** Parse + check a FULL program and build it for one arch. Returns the code
 *  of main's section only (library code shares the file). */
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
 * String assignment/mv semantics under D3 (string is OWNING): a bare
 * `s = t` from another string binding is a compile error. An independent
 * copy is spelled `s = t.copy()` (a real heap copy, freed like any owned
 * string); a transfer is spelled `s = mv t` (the source is invalidated and
 * the pair moves). A string LITERAL initializer stays a fresh heap value.
 * These pins keep the original memory-soundness intent: independent copies
 * must not alias, transfers must free exactly once, and a variable that
 * receives a borrow and later a heap value must own heap on every path
 * (now spelled `.copy()` at the borrow reception — the retired silent
 * strdup-at-restart is gone).
 */

test("cross-scope assign then plain read prints the copied value", async () => {
	const input = `
import System

pub func main = () {
	var string s = "init"
	if true {
		var string t = 42.to_string()
		s = t.copy()
	}
	Console.write(s)
}
`;
	await run_program(input, "string_assign_cross_scope_read", "42");
});

test("no-initializer assignee: assign out of an inner scope, read after", async () => {
	// The eager displaced-value free must see a zeroed pair (C emits
	// `= {0, 0}` for no-init string locals), and the copied value must
	// survive the source's scope exit.
	const input = `
import System

pub func main = () {
	var string s
	if true {
		var string t = 42.to_string()
		s = t.copy()
	}
	Console.write(s)
}
`;
	await run_program(input, "string_assign_noinit_target", "42");
});

test("assign then return of the assignee hands the caller its own copy", async () => {
	const input = `
import System

func f = (out string) {
	var string t = 42.to_string()
	var string s = "init"
	s = t.copy()
	return s
}

pub func main = () {
	Console.write(f())
}
`;
	await run_program(input, "string_assign_return_escape", "42");
});

test("ref mutation after the assign stays isolated to the assignee", async () => {
	const input = `
import System

pub func main = () {
	var string t = 42.to_string()
	var string s = "init"
	s = t.copy()
	var int i = 0
	while i < s.length; i += 1 {
		s.set(i, 'X')
	}
	Console.write(s)
	Console.write(t)
}
`;
	await run_program(input, "string_assign_mutation_isolated", "XX42");
});

test("same-scope assign reads both names and frees exactly once", async () => {
	const input = `
import System

pub func main = () {
	var string t = 42.to_string()
	var string s = "init"
	s = t.copy()
	Console.write(s)
	Console.write(t)
}
`;
	await run_program(input, "string_assign_same_scope_reads", "4242");
});

test("loop accumulator keeps working (explicit mv)", async () => {
	// The accumulator is heap-initialized (`"".to_string()`) so the in-loop
	// reassign's displaced-value free is emitted on both backends; the loop
	// then transfers each iteration's fresh string with `mv part`.
	const input = `
import System

pub func main = () {
	var string acc = "".to_string()
	var int i = 0
	while i < 3; i += 1 {
		var string part = i.to_string()
		acc = mv part
		i += 1
	}
	Console.write(acc)
}
`;
	await run_program(input, "string_assign_loop_accumulator", "2");
});

test("explicit mv transfers (no strdup, single free)", async () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	var string s = "init"
	s = mv t
	Console.write(s)
}
`;
	await run_program(input, "string_assign_move_last_use", "aaaa");

	// `s`'s literal initializer is heap-forced (the target of a value assign
	// owns heap), so its throwaway literal copy is eager-freed at the
	// reassign, and the transferred pair is freed once at exit — through s.
	// t's own free stays in the body but is FLAG-GUARDED
	// (`if (!_mv_owns_t)`): the transfer set the flag, so the guard skips at
	// runtime; keeping the free alive preserves the not-taken path's reclaim
	// when the transfer is conditional (the loop-local leak fix). Three frees.
	const c = build_main(input, "c");
	expect(c).toContain("s = t;");
	expect(c).not.toContain("nomen_str_dup(t)");
	expect(c).toContain("if (!_mv_owns_t) { free(t.ptr); }");
	expect(count(c, "free(")).toBe(3);

	const a64 = build_main(input, "aarch64");
	expect(count(a64, "bl string_to_string")).toBe(1);
	// The transfer copies the pair with no allocator call; s's literal init
	// copy is strdup'd (the transfer makes s a heap receptacle), and the
	// frees are the displaced literal at the reassign, t's flag-guarded
	// donor free (skipped at runtime), and the transferred block at exit.
	expect(count(a64, "bl _strdup")).toBe(1);
	expect(count(a64, "bl _free")).toBe(3);
});

test("read-after demands an explicit copy (both names get a copy)", async () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	var string s = "init"
	s = t.copy()
	Console.write(s)
	Console.write(t)
}
`;
	await run_program(input, "string_assign_move_refused_read", "aaaa");

	const c = build_main(input, "c");
	// D3: the independent copy is a spelled `.copy()` (a heap deep copy).
	expect(c).toContain("string_copy(t)");
	// s's forced literal copy (eager-freed at the reassign), t's own copy,
	// and s's copied value at exit.
	expect(count(c, "free(")).toBe(3);
});

test.skip("kill-switch off restores the strdup'd assign copy", () => {
	// Retired by D3: a bare `s = t` from another string binding is now a
	// compile error, so there is no silent copy for the kill-switch to
	// restore. The explicit `mv`/`.copy()` spellings are unconditional.
});

/**
 * Borrow-INITIALIZED assignees under D3: receiving a string borrow into an
 * mv local is spelled `src.at(0).copy()` — an owned heap copy — and a
 * later heap value is spelled `b = mv t`. The target owns heap on every
 * path (the copy is always heap), so the unconditionally emitted reassign
 * and scope-exit frees are valid even when the reassign branch never
 * executes. The retired silent strdup-at-restart is gone.
 */

test("borrow-initialized assignee: heap reassign in a branch, read after", async () => {
	const input = `
import System

pub func main = () {
	var string[] src = ["hello"]
	var string b = src.at(0).copy()
	if true {
		var string t = 42.to_string()
		b = mv t
	}
	Console.write(b)
}
`;
	await run_program(input, "string_assign_borrow_init_assignee", "42");
});

test("borrow-reception assignee: heap reassign in a branch, reads around", async () => {
	const input = `
import System

pub func main = () {
	var string[] src = ["hello"]
	var string b
	b = src.at(0).copy()
	Console.write(b)
	if true {
		var string t = 42.to_string()
		b = mv t
	}
	Console.write(b)
}
`;
	await run_program(input, "string_assign_borrow_receptacle", "hello42");
});

test("borrow-reception assignee: restart inside a loop frees each copy", async () => {
	const input = `
import System

pub func main = () {
	var string[] src = ["hello"]
	var string b
	b = src.at(0).copy()
	var int i = 0
	while i < 3; i += 1 {
		var string t = i.to_string()
		b = mv t
		Console.write(b)
	}
	Console.write(b)
}
`;
	await run_program(input, "string_assign_borrow_receptacle_loop", "0122");
});

test("UNTAKEN restart branch leaves the copy alive (no invalid free)", async () => {
	const input = `
import System

pub func main = () {
	var string[] src = ["hello"]
	var string b
	b = src.at(0).copy()
	if 1 < 0 {
		var string t = 42.to_string()
		b = mv t
	}
	Console.write(b)
}
`;
	await run_program(input, "string_assign_borrow_restart_untaken", "hello");
});

test("UNTAKEN restart branch, borrow-init declare assignee", async () => {
	const input = `
import System

pub func main = () {
	var string[] src = ["hello"]
	var string b = src.at(0).copy()
	if 1 < 0 {
		var string t = 42.to_string()
		b = mv t
	}
	Console.write(b)
}
`;
	await run_program(input, "string_assign_borrow_init_untaken", "hello");
});

test("plain borrow read stays a raw borrow (no forced strdup leak)", async () => {
	const input = `
import System

pub func main = () {
	var string[] src = ["hello"]
	var string b = src.at(0)
	Console.write(b)
}
`;
	await run_program(input, "string_assign_plain_borrow_read", "hello");
	const c = build_main(input, "c");
	expect(c).toContain("b = (src[0L]);");
	expect(c).not.toContain("nomen_str_dup(src[0L]");
});

/**
 * Explicit `s = mv t` keeps its transfer path — and it must actually
 * TRANSFER: the source's scope-exit free is suppressed and the assignee
 * frees the bytes once. The pre-fix lowering freed BOTH (C) or left the
 * assignee dangling (aarch64).
 */

test("explicit mv transfers (single owner, no double free)", async () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	var string s = "init"
	s = mv t
	Console.write(s)
}
`;
	await run_program(input, "string_assign_explicit_mov_transfer", "aaaa");
	const c = build_main(input, "c");
	expect(c).toContain("s = t;");
	expect(c).not.toContain("nomen_str_dup(t)");
	// s's heap-forced literal init copy (eager-freed at the reassign), t's
	// FLAG-GUARDED donor free (the transfer set _mv_owns_t, so the guard
	// skips at runtime — the single owner is s), and the transferred block
	// at scope exit.
	expect(c).toContain("if (!_mv_owns_t) { free(t.ptr); }");
	expect(count(c, "free(")).toBe(3);
});

/**
 * D3: a mv string initialized from another binding must be spelled —
 * `mv u = t` transfers, then `s = mv u` transfers again. The
 * declaration-keyword mv lowers to a pair assignment with the donor's free
 * statically spliced (`mv u = t` is unconditional); the ASSIGNMENT mv keeps
 * the donor's free in the body under its runtime owns-flag — the flag is
 * set on the transfer path, so the guard skips there and the bytes are
 * freed exactly once, through s.
 */

test("explicit-mv initializer source transfers", () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	mv u = t
	var string s = "init"
	s = mv u
	Console.write(s)
}
`;
	const c = build_main(input, "c");
	expect(c).toContain("s = u;");
	expect(c).not.toContain("nomen_str_dup(u)");
	// s's heap-forced literal init copy (eager-freed at the reassign), u's
	// flag-guarded donor free (skipped at runtime), and the final copy at
	// scope exit.
	expect(count(c, "free(")).toBe(3);
	expect(c).toContain("if (!_mv_owns_u) { free(u.ptr); }");

	const a64 = build_main(input, "aarch64");
	expect(count(a64, "bl _strdup")).toBe(2);
});
