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

/** Parse + check a FULL program and build it for one arch. Returns the code
 *  of main's section only (library code shares the file). */
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
 * Plain string assignment VALUE SEMANTICS (`s = t` strdups an owned copy) +
 * move-on-last-use assignment transfer (`s = t` with a provably dead source
 * transfers the pair instead). The alias lowering this replaced dangled the
 * target whenever the source's scope ended first, leaked through returns of
 * the assignee, and made writes through `ref` visible in both variables.
 * Ownership restart: a variable that receives a borrow and later a heap
 * value (`b = src.at(0)` … `b = t`) owns heap on every path — borrow
 * receptions are strdup'd, so the frees stay valid even when the restart
 * branch never executes. Explicit `s = mov t` transfers the ownership mark.
 */

test("cross-scope assign then plain read prints the copied value", async () => {
	const input = `
import System

pub func main = () {
	var string s = "init"
	if true {
		var string t = 42.to_string()
		s = t
	}
	Console.write(s)
}
`;
	await run_program(input, "string_assign_cross_scope_read", "42");
});

test("no-initializer assignee: assign out of an inner scope, read after", async () => {
	// The eager displaced-value free must see a zeroed pair (C emits
	// `= {0, 0}` for no-init string locals), and the transferred/copied
	// value must survive the source's scope exit.
	const input = `
import System

pub func main = () {
	var string s
	if true {
		var string t = 42.to_string()
		s = t
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
	s = t
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
	s = t
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
	s = t
	Console.write(s)
	Console.write(t)
}
`;
	await run_program(input, "string_assign_same_scope_reads", "4242");
});

test("loop accumulator keeps working (move on last use)", async () => {
	const input = `
import System

pub func main = () {
	var string acc = ""
	var int i = 0
	while i < 3; i += 1 {
		var string part = i.to_string()
		acc = part
		i += 1
	}
	Console.write(acc)
}
`;
	await run_program(input, "string_assign_loop_accumulator", "2");
});

test("last-use assign transfers (no strdup, single free)", async () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	var string s = "init"
	s = t
	Console.write(s)
}
`;
	await run_program(input, "string_assign_move_last_use", "aaaa");

	// `s`'s literal initializer is heap-forced (the target of a value-copy
	// assign owns heap from the first reassignment on), so its throwaway
	// literal copy is eager-freed at the reassign and the transferred pair is
	// freed once at exit: two frees, one alloc-for-nothing saved.
	const c = build_main(input, "c");
	expect(c).toContain("s = t;");
	expect(c).not.toContain("nomen_str_dup(t)");
	expect(count(c, "free(")).toBe(2);

	const a64 = build_main(input, "aarch64");
	expect(count(a64, "bl string_to_string")).toBe(1);
	expect(count(a64, "bl _strdup")).toBe(1);
	expect(count(a64, "bl _free")).toBe(2);
});

test("read-after refuses the assign move (both names get a copy)", async () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	var string s = "init"
	s = t
	Console.write(s)
	Console.write(t)
}
`;
	await run_program(input, "string_assign_move_refused_read", "aaaa");

	const c = build_main(input, "c");
	expect(c).toContain("nomen_str_dup(t)");
	// s's forced literal copy (eager-freed at the reassign), t's own copy,
	// and s's assign copy at exit.
	expect(count(c, "free(")).toBe(3);
});

test("kill-switch off restores the strdup'd assign copy", () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	var string s = "init"
	s = t
	Console.write(s)
}
`;
	set_move_on_last_use_enabled(false);
	try {
		const c = build_main(input, "c");
		expect(c).toContain("nomen_str_dup(t)");
		expect(c).not.toContain("s = t;");

		const a64 = build_main(input, "aarch64");
		// s's heap-forced literal initializer + the assign's strdup.
		expect(count(a64, "bl _strdup")).toBe(2);
	} finally {
		set_move_on_last_use_enabled(true);
	}
});

/**
 * Borrow-INITIALIZED assignees (`var string b = src.at(0)` / `b = src.at(0)`
 * followed by a plain heap reassign `b = t`). Ownership RESTART: the target
 * becomes a full owner on every path — borrow receptions are strdup'd into
 * owned copies so the (unconditionally emitted) reassign and scope-exit
 * frees are valid even when the restart branch never executes. The pre-fix
 * lowering left the variables aliasing (cross-scope dangle of a borrow) or
 * freed the container's storage outright.
 */

test("borrow-initialized assignee: heap reassign in a branch, read after", async () => {
	const input = `
import System

pub func main = () {
	var string[] src = ["hello"]
	var string b = src.at(0)
	if true {
		var string t = 42.to_string()
		b = t
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
	b = src.at(0)
	Console.write(b)
	if true {
		var string t = 42.to_string()
		b = t
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
	b = src.at(0)
	var int i = 0
	while i < 3; i += 1 {
		var string t = i.to_string()
		b = t
		Console.write(b)
	}
	Console.write(b)
}
`;
	await run_program(input, "string_assign_borrow_receptacle_loop", "0122");
});

test("UNTAKEN restart branch leaves the borrow alive (no invalid free)", async () => {
	const input = `
import System

pub func main = () {
	var string[] src = ["hello"]
	var string b
	b = src.at(0)
	if 1 < 0 {
		var string t = 42.to_string()
		b = t
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
	var string b = src.at(0)
	if 1 < 0 {
		var string t = 42.to_string()
		b = t
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
 * Explicit `s = mov t` keeps its transfer path — and it must actually
 * TRANSFER: the source's scope-exit free is suppressed and the assignee
 * frees the bytes once. The pre-fix lowering freed BOTH (C) or left the
 * assignee dangling (aarch64).
 */

test("explicit mov transfers (single owner, no double free)", async () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	var string s = "init"
	s = mov t
	Console.write(s)
}
`;
	await run_program(input, "string_assign_explicit_mov_transfer", "aaaa");
	const c = build_main(input, "c");
	expect(c).toContain("s = t;");
	expect(c).not.toContain("nomen_str_dup(t)");
	// s's heap-forced literal init copy (eager-freed at the reassign) + the
	// transferred block at scope exit. t's free was spliced.
	expect(count(c, "free(")).toBe(2);
});

/**
 * The C move gate now accepts bare-variable-INITIALIZER sources: the
 * declare site records the strdup'd/transferred copy in heap_strings, so
 * `var u = t; s = u` transfers (aarch64 already did via heap_strings).
 */

test("bare-variable-initializer source moves on last use", () => {
	const input = `
import System

pub func main = () {
	var t = "aaaa".to_string()
	var u = t
	var string s = "init"
	s = u
	Console.write(s)
}
`;
	const c = build_main(input, "c");
	expect(c).toContain("s = u;");
	expect(c).not.toContain("nomen_str_dup(u)");
	// s's heap-forced literal init copy (eager-freed at the reassign) + the
	// final copy at scope exit; t and u were both moved (suppressed frees).
	expect(count(c, "free(")).toBe(2);

	const a64 = build_main(input, "aarch64");
	expect(count(a64, "bl _strdup")).toBe(1);
});
