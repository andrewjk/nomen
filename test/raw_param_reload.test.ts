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

// ---------------------------------------------------------------------------
// Raw `#arch: aarch64` blocks are spliced verbatim wherever their statement
// sits, but they read their parameters from the entry ABI registers (x0,
// x1, …). Before the fix, a block sitting after any control flow read the
// scratch values those registers held by then (FOLLOWUP.md: the switch-case
// `strb w2, [x0]` wrote to address 1 instead of the string). Away from the
// body's entry point the prologue homes are reloaded first.
// ---------------------------------------------------------------------------

// The FOLLOWUP repro: a raw block in a switch case mutates the string param
// through x0/x1 (ptr/len pair) and reports the written byte through a ref
// sink in x2. (The C block is written fat-aware — `p.ptr` — to skip the
// mixed-function const-char* shim.)
test("raw aarch64 block after a switch sees its params", async () => {
	await run_program(
		`
import System

func raw_touch = (string p, ref uint8 sink) {
	switch {
		case true {
			\`\`\`
			#arch: c
			p.ptr[0] = 'X';
			*sink = (unsigned char)p.ptr[0];
			\`\`\`
			\`\`\`
			#arch: aarch64
			mov w4, #88
			strb w4, [x0]
			ldrb w3, [x0]
			strb w3, [x2]
			\`\`\`
		}
	}
}

pub func main = () {
	var s = "hello".to_string()
	var uint8 sink = 0
	raw_touch(s.to_string(), ref sink)
	Console.write_line(sink.to_string())
}
`,
		"raw_reload_switch",
		"88",
	);
});

// Same class through an `if` body, with a scalar (int) param: x2 must hold
// the reloaded index (zero-extended from its 4-byte slot) when the block
// indexes through the pair in x0/x1.
test("raw aarch64 block after an if sees scalar and pair params", async () => {
	await run_program(
		`
import System

func raw_read_at = (string p, int i, ref uint8 seen) {
	if i >= 0 {
		\`\`\`
		#arch: c
		*seen = (unsigned char)p.ptr[i];
		\`\`\`
		\`\`\`
		#arch: aarch64
		ldrb w4, [x0, x2]
		strb w4, [x3]
		\`\`\`
	}
}

pub func main = () {
	var s = "hello".to_string()
	var uint8 seen = 0
	raw_read_at(s.to_string(), 1, ref seen)
	Console.write_line(seen.to_string())
}
`,
		"raw_reload_if",
		"101",
	);
});

// Same class inside a loop body: the reload splices on every iteration, and
// the refs (x1 = &storage) survive the loop's own register traffic.
test("raw aarch64 block inside a while sees its params", async () => {
	await run_program(
		`
import System

func raw_count = (int n, ref int total) {
	var i = 0
	while i < 3 {
		\`\`\`
		#arch: c
		*total = *total + n;
		\`\`\`
		\`\`\`
		#arch: aarch64
		ldr w4, [x1]
		add w4, w4, w0
		str w4, [x1]
		\`\`\`
		i = i + 1
	}
}

pub func main = () {
	var total = 0
	raw_count(5, ref total)
	Console.write_line(total.to_string())
}
`,
		"raw_reload_while",
		"15",
	);
});

// A method's non-self params reload too: self rides callee-saved x19, the
// string pair rides slots 1-2, the ref sink slot 3.
test("raw aarch64 block after control flow in a method sees its params", async () => {
	await run_program(
		`
import System

struct Toucher {
	pub func poke = (self, string p, ref uint8 sink) {
		if p.length > 0 {
			\`\`\`
			#arch: c
			p.ptr[0] = 'X';
			*sink = (unsigned char)p.ptr[0];
			\`\`\`
			\`\`\`
			#arch: aarch64
			mov w4, #88
			strb w4, [x1]
			ldrb w5, [x1]
			strb w5, [x3]
			\`\`\`
		}
	}
}

pub func main = () {
	var t = Toucher()
	var s = "hello".to_string()
	var uint8 sink = 0
	t.poke(s.to_string(), ref sink)
	Console.write_line(sink.to_string())
}
`,
		"raw_reload_method",
		"88",
	);
});

// A whole-function-promoted int param skips its slot spill entirely — the
// value lives only in its callee-saved register, so the reload is a move
// from there, not a slot load.
test("raw aarch64 block after control flow reads a promoted int param", async () => {
	await run_program(
		`
import System

func id = (int v, out int) {
	return v
}

func peek = (int v, out int) {
	return id(v) * 2
}

func spin = (int n, ref int seen) {
	var i = 0
	var t = n * 2
	while i < 10 {
		t = peek(t) - t / 2 + t
		i = i + 1
	}
	var checksum = n + n + n + n + n + t
	if checksum > n {
		\`\`\`
		#arch: c
		*seen = n;
		\`\`\`
		\`\`\`
		#arch: aarch64
		str w0, [x1]
		\`\`\`
	}
}

pub func main = () {
	var seen = 0
	spin(3, ref seen)
	Console.write_line(seen.to_string())
}
`,
		"raw_reload_promoted_int",
		"3",
	);
});

// Same for a promoted float param: the prologue parked the bits with fmov,
// so the reload is fmov back into the entry x register.
test("raw aarch64 block after control flow reads a promoted float param", async () => {
	await run_program(
		`
import System

func fscale = (float a, float b, ref float seen) {
	var i = 0
	var float acc = 0.0
	while i < 8 {
		acc = acc + a * b - a + a * b - a
		i = i + 1
	}
	if acc < 0.0 {
		\`\`\`
		#arch: c
		*seen = a;
		\`\`\`
		\`\`\`
		#arch: aarch64
		str x0, [x2]
		\`\`\`
	}
}

pub func main = () {
	var float seen = 0.0
	fscale(2.0, 0.5, ref seen)
	Console.write_line(seen.to_string())
}
`,
		"raw_reload_promoted_float",
		"2",
	);
});

// A nested function installs its own plan (and restores the enclosing one):
// the raw block reads the inner function's params, not the outer's.
test("raw aarch64 block after control flow in a nested function", async () => {
	await run_program(
		`
import System

pub func main = () {
	func inner = (string p, ref uint8 sink) {
		if p.length > 0 {
			\`\`\`
			#arch: c
			*sink = (unsigned char)p.ptr[0];
			\`\`\`
			\`\`\`
			#arch: aarch64
			ldrb w4, [x0]
			strb w4, [x2]
			\`\`\`
		}
	}
	var s = "hello".to_string()
	var uint8 sink = 0
	inner(s.to_string(), ref sink)
	Console.write_line(sink.to_string())
}
`,
		"raw_reload_nested",
		"104",
	);
});

// Entry-position blocks (the shape all of core/ uses) splice verbatim with
// NO reload lines: the registers still hold the entry values.
test("entry-position raw block gets no reload lines", () => {
	const input = `
import System

func raw_first = (string p, ref uint8 sink) {
	\`\`\`
	#arch: c
	*sink = (unsigned char)p.ptr[0];
	\`\`\`
	\`\`\`
	#arch: aarch64
	ldrb w3, [x0]
	strb w3, [x2]
	\`\`\`
}

pub func main = () {
	var s = "hello".to_string()
	var uint8 sink = 0
	raw_first(s.to_string(), ref sink)
	Console.write_line(sink.to_string())
}
`;
	const a64 = build_code(input, "aarch64");
	const body = a64.split("raw_first:\n")[1].split(".p2align")[0];
	expect(body).toContain("ldrb w3, [x0]");
	expect(body).not.toContain("ldr x0, [x29");
});
