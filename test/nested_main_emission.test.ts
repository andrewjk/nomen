import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { validate_stack_balance } from "../src/build_aarch64/lift_asm";
import parse_with_imports, { parse_program } from "./parse_with_imports";

// A `main` declared inside another function body (the parse_with_imports
// harness wrapping a pasted full program — the shape behind the retired
// FOLLOWUP "aarch64: an early bare `return` in `main` emits invalid
// assembly") is an ordinary nested function under its uniquified
// `label_name`. Nesting used to exclude `main`: the nested main emitted
// INLINE in the enclosing body with a SECOND global `_main` label (clang:
// "symbol '_main' is already defined") and its prologue/epilogue rode the
// enclosing function's code stream (the enclosing epilogue sat unreachable
// after the nested `ret`). These tests pin: one `_main`, the nested main
// under its label, clean stack balance, and the generated TU actually
// assembles — for the entry main and its early bare `return` too.

function assemble(arch: string, code: string): void {
	const dir = tmpdir();
	const file = path.join(dir, `nomen_assemble_check_${Date.now()}.s`);
	writeFileSync(file, code);
	execFileSync(
		"clang",
		["-arch", arch, "-x", "assembler", "-c", file, "-o", path.join(dir, "nomen_assemble_check.o")],
		{ stdio: "pipe" },
	);
}

test("a nested pub func main emits under its uniquified label (single _main)", () => {
	const input = `
pub func main = () {
	var e = 1
	if e < 0 { return }
	Console.write("\\{e}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(result.errors ?? []).toEqual([]);
	// Exactly one global `_main` label — the wrapper's.
	const defs = (result.code as string).match(/^_main:/gm) ?? [];
	expect(defs.length).toBe(1);
	expect(result.code as string).toContain("main_main:");
	expect(validate_stack_balance(result.code as string)).toEqual([]);
	assemble("arm64", result.code as string);
});

test("a bare return in main (harness-wrapped) still builds and assembles", () => {
	const input = `
var e = 1
if e < 0 { return }
Console.write("ok\\n")
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(result.errors ?? []).toEqual([]);
	expect(validate_stack_balance(result.code as string)).toEqual([]);
	assemble("arm64", result.code as string);
});

test("top-level main keeps its entry epilogue (audit check, x0 = 0)", () => {
	const input = `
import System
pub func main = () {
	var e = 1
	if e < 0 { return }
	Console.write("done\\n")
}
`;
	const parsed = parse_program(input);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect(result.errors ?? []).toEqual([]);
	expect(result.code as string).toContain("bl _nomen_audit_check");
	assemble("arm64", result.code as string);
});
