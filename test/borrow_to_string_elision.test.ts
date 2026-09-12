import fs from "node:fs";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import build, { build_needs_objc, default_platform } from "../src/build";
import { set_borrow_to_string_elision_enabled } from "../src/check/utils/string_mutation_scan";
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
 *  arch, returning the emitted code. */
function build_code(input: string, arch: "aarch64" | "c"): string {
	const parsed = parse(input, system, undefined, { allow_user_raw: true });
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch, audit: false });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

/** Compile + run a full program on BOTH backends and pin its stdout. Mirrors
 *  bench helpers: link the precompiled system object when available. */
async function run_program(input: string, name: string, expected: string) {
	const parsed = parse(input, system, undefined, { allow_user_raw: true });
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

// ---------------------------------------------------------------------------
// Runtime behavior (both backends, outputs pinned): the elision must be
// observably transparent — borrows behave like copies — and the mutation
// gate must hold: a callee that reaches the bytes through its plain string
// param gets a real copy, so the caller's string stays intact.
// ---------------------------------------------------------------------------

test("borrow-position to_string elides; raw-body mutator gets a copy", async () => {
	await run_program(
		`
import System

func consume = (string s, out int) {
	return s.length
}

// Writes through the param's pointer — opaque to the AST scan on BOTH
// backends (C indexes the char*, asm stores through x0).
func raw_touch = (string p) {
	\`\`\`
	#arch: c
	p[0] = 'J';
	\`\`\`
	\`\`\`
	#arch: aarch64
	mov w2, #74
	strb w2, [x0]
	\`\`\`
}

pub func main = () {
	var s = "hello".to_string()
	Console.write_line(consume(s.to_string()).to_string())
	raw_touch(s.to_string())
	Console.write_line(s)
}
`,
		"borrow_to_string_gate",
		"5\nhello",
	);
});

test("raw mutator gated when the blocks sit inside a switch case (gate pin, both backends)", () => {
	// Same gate as the top-level pin above, but the raw blocks are statements
	// of a switch case: the mutation scan's AST walk must see through the case
	// list, or the borrow-position to_string elides and the caller's bytes
	// would be clobbered by the callee.
	const input = `
import System

func raw_touch = (string p) {
	switch {
		case true {
			\`\`\`
			#arch: c
			p[0] = 'J';
			\`\`\`
			\`\`\`
			#arch: aarch64
			mov w2, #74
			strb w2, [x0]
			\`\`\`
		}
	}
}

pub func main = () {
	var s = "hello".to_string()
	raw_touch(s.to_string())
}
`;
	const a64 = build_code(input, "aarch64");
	expect(count(a64, "bl string_to_string")).toBe(2);
	const c = build_code(input, "c");
	expect(c).toContain("string_to_string(s)");
});

test("transitive scan: read-only forwarding elides, raw-mutating forwarding copies", async () => {
	await run_program(
		`
import System

func read_len = (string p, out int) {
	return p.length
}

func forward = (string p, out int) {
	return read_len(p)
}

func raw_touch = (string p) {
	\`\`\`
	#arch: c
	p[0] = 'Z';
	\`\`\`
	\`\`\`
	#arch: aarch64
	mov w2, #90
	strb w2, [x0]
	\`\`\`
}

func forward_touch = (string p) {
	raw_touch(p)
}

pub func main = () {
	var s = "hello".to_string()
	Console.write_line(forward(s.to_string()).to_string())
	Console.write_line(s)
	forward_touch(s.to_string())
	Console.write_line(s)
}
`,
		"borrow_to_string_transitive",
		"5\nhello\nhello",
	);
});

test("elided borrow through a field receiver (self.name)", async () => {
	await run_program(
		`
import System

func consume = (string s, out int) {
	return s.length
}

struct Box {
	var string name
	pub func show = (self) {
		Console.write_line(consume(self.name.to_string()).to_string())
		Console.write_line(self.name)
	}
}

pub func main = () {
	var b = Box("carton")
	b.show()
}
`,
		"borrow_to_string_field",
		"6\ncarton",
	);
});

// ---------------------------------------------------------------------------
// Code shape: the strdup + temp + free actually disappear, per consumer
// class. `var s = "hello".to_string()` is an OWNED declaration — its
// string_to_string is semantically necessary and stays; these pins count
// exactly one.
// ---------------------------------------------------------------------------

const SHAPE_PROLOG = `
import System

func consume = (string s, out int) {
	return s.length
}

pub func main = () {
	var s = "hello".to_string()
`;

test("elided call arg: one strdup total (the owned declaration)", () => {
	const input = `${SHAPE_PROLOG}
	var n = consume(s.to_string())
	Console.write(n.to_string())
}
`;
	const a64 = build_code(input, "aarch64");
	expect(count(a64, "bl string_to_string")).toBe(1);
	const c = build_code(input, "c");
	expect(c).toContain("consume(s);");
	expect(c).not.toContain("string_to_string(s)");
	// No hoisted temporary for the argument anymore.
	expect(c).not.toMatch(/_param_\d+ = string_to_string/);
});

test("concat operand: the copy and its post-concat free disappear", () => {
	const input = `${SHAPE_PROLOG}
	var t = "x" + s.to_string()
	Console.write(t)
}
`;
	const a64 = build_code(input, "aarch64");
	expect(count(a64, "bl string_to_string")).toBe(1);
	expect(count(a64, "bl string_add")).toBe(1);
	const c = build_code(input, "c");
	expect(c).toContain('string_add(nomen_str_lit("x", 1), s);');
	expect(c).not.toContain("string_to_string(s)");
});

test("raw-mutating callee keeps its owned copy (gate pin, both backends)", () => {
	const input = `
import System

func raw_touch = (string p) {
	\`\`\`
	#arch: c
	p[0] = 'J';
	\`\`\`
	\`\`\`
	#arch: aarch64
	mov w2, #74
	strb w2, [x0]
	\`\`\`
}

pub func main = () {
	var s = "hello".to_string()
	raw_touch(s.to_string())
}
`;
	const a64 = build_code(input, "aarch64");
	expect(count(a64, "bl string_to_string")).toBe(2);
	const c = build_code(input, "c");
	expect(c).toContain("string_to_string(s)");
});

test("transitive raw mutator keeps its owned copy (gate pin, both backends)", () => {
	const input = `
import System

func raw_touch = (string p) {
	\`\`\`
	#arch: c
	p[0] = 'J';
	\`\`\`
	\`\`\`
	#arch: aarch64
	mov w2, #74
	strb w2, [x0]
	\`\`\`
}

func forward_touch = (string p) {
	raw_touch(p)
}

pub func main = () {
	var s = "hello".to_string()
	forward_touch(s.to_string())
}
`;
	const a64 = build_code(input, "aarch64");
	expect(count(a64, "bl string_to_string")).toBe(2);
	const c = build_code(input, "c");
	expect(c).toContain("string_to_string(s)");
});

test("view params are outside the tranche (copies stay)", () => {
	const input = `
import System

func show_view = (view string v, out int) {
	return v.length
}

pub func main = () {
	var s = "hello".to_string()
	var a = show_view(s.to_string())
	Console.write(a.to_string())
}
`;
	// The owned declaration plus the view position's copy.
	const a64 = build_code(input, "aarch64");
	expect(count(a64, "bl string_to_string")).toBe(2);
	const c = build_code(input, "c");
	expect(count(c, "string_to_string(s)")).toBe(1);
});

test("int receiver to_string is untouched: its temp is still hoisted and freed", () => {
	const input = `
import System

pub func main = () {
	var n = 41
	Console.write(n.to_string())
}
`;
	const c = build_code(input, "c");
	expect(c).toContain("int_to_string(n)");
	expect(c).toContain("free(_param_0.ptr)");
});

test("raw-body consumer: printf-style passes the scan, indexing-style does not", () => {
	const input = `
import System

func raw_print = (string p) {
	\`\`\`
	#arch: c
	printf("%s", p);
	\`\`\`
	\`\`\`
	#arch: aarch64
	mov x2, x0
	adr x0, .Lfmt_raw_print_test
	mov x1, x2
	bl _printf
	b .Lend_raw_print_test
	.Lfmt_raw_print_test: .asciz "%s"
	.p2align 2
	.Lend_raw_print_test:
	\`\`\`
}

func raw_peek = (string p, out int) {
	\`\`\`
	#arch: c
	return p[0];
	\`\`\`
	\`\`\`
	#arch: aarch64
	ldrb w0, [x0]
	\`\`\`
}

pub func main = () {
	var s = "hello".to_string()
	raw_print(s.to_string())
	var m = raw_peek(s.to_string())
	Console.write(m.to_string())
}
`;
	// raw_print is provably non-mutating (no stores; printf reads only) —
	// its argument elides. raw_peek indexes the param in its C body — the
	// conservative textual rule rejects the elision and the copy stays.
	// Total strdups: the declaration + raw_peek's copy = 2.
	const a64 = build_code(input, "aarch64");
	expect(count(a64, "bl string_to_string")).toBe(2);
	const c = build_code(input, "c");
	expect(count(c, "string_to_string(s)")).toBe(1);
});

// ---------------------------------------------------------------------------
// Kill-switch: OFF must restore the un-elided emission byte-identically
// (standing invariant 3). Every expectation here opts in and restores.
// ---------------------------------------------------------------------------

test("kill-switch off restores the pre-tranche output", () => {
	const input = `${SHAPE_PROLOG}
	var n = consume(s.to_string())
	Console.write(n.to_string())
}
`;
	const on_a64 = build_code(input, "aarch64");
	expect(count(on_a64, "bl string_to_string")).toBe(1);

	let off_a64 = "";
	let off_c = "";
	set_borrow_to_string_elision_enabled(false);
	try {
		off_a64 = build_code(input, "aarch64");
		off_c = build_code(input, "c");
	} finally {
		set_borrow_to_string_elision_enabled(true);
	}
	expect(count(off_a64, "bl string_to_string")).toBe(2);
	expect(off_c).toContain("string_to_string(s)");
	expect(off_c).toContain("consume(_param_0);");
});
