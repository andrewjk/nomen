import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import check_output from "./check_output";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

// A module-level primitive `const` with a COMPILE-TIME-CONSTANT initializer
// (an op chain, a reference to another const) used to reserve zeroed
// storage on aarch64 and emit the store as dead code between functions —
// every read observed 0 (FOLLOWUP.md). The aarch64 declaration emitter now
// folds such initializers straight into the data directive. The C backend
// was already correct (it emits the expression and clang folds it).

function build_const(source: string, arch: "c" | "aarch64", audit = false) {
	const parsed = parse(source, system, undefined, { allow_internal: true });
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { arch, audit });
}

describe("module-level primitive const initializers", () => {
	test("aarch64 folds literal op chains into the data directive", () => {
		const result = build_const(
			`
import System

pub const LEVELS = 3 + 4
pub const MASK = (1 << 20) - 1
pub const NEG = 0 - 9
`,
			"aarch64",
		);
		const code = result.code;
		expect(code).toContain("LEVELS: .quad 7");
		expect(code).toContain("MASK: .quad 1048575");
		expect(code).toContain("NEG: .quad -9");
		expect(code).not.toContain("LEVELS: .space");
	});

	test("aarch64 folds references to other consts (any declaration order)", () => {
		const result = build_const(
			`
import System

pub const B = A + 1
pub const A = 40
`,
			"aarch64",
		);
		expect(result.code).toContain("B: .quad 41");
		expect(result.code).toContain("A: .quad 40");
	});

	test("both backends run the folded values (either order)", async () => {
		for (const decls of [
			`pub const LEVELS = 3 + 4\npub const MASK = (1 << 20) - 1`,
			`pub func main = () {\n\tConsole.write_line(LEVELS.to_string())\n\tConsole.write_line(MASK.to_string())\n}\n\npub const LEVELS = 3 + 4\npub const MASK = (1 << 20) - 1`,
		]) {
			const source = decls.startsWith("pub func")
				? `import System\n\n${decls}\n`
				: `import System\n\n${decls}\n\npub func main = () {\n\tConsole.write_line(LEVELS.to_string())\n\tConsole.write_line(MASK.to_string())\n}\n`;
			const name = decls.startsWith("pub func") ? "below_use" : "above_use";
			for (const arch of ["c", "aarch64"] as const) {
				const result = build_const(source, arch);
				await check_output(`const_scalar_init_${name}_${arch}`, result, "7\n1048575\n", {
					arch,
					audit: false,
				});
			}
		}
	});

	test("a runtime-only initializer is left alone (no bogus fold)", () => {
		// `f()` is not a constant expression; the emitter must not invent a
		// value for it. (Genuinely runtime module initializers are unsupported
		// on both backends — this only guards against a wrong fold.)
		const result = build_const(
			`
import System

func f = (out int) { return 5 }

pub const N = f()

pub func main = () {
	Console.write_line(N.to_string())
}
`,
			"aarch64",
		);
		expect(result.code).not.toContain("N: .quad 5");
	});
});
