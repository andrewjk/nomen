import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import check_output from "./check_output";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

function build_code(input: string, arch: "c" | "aarch64") {
	const parsed = parse(input, system, undefined, { allow_internal: true });
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { arch, audit: false });
}

function main_body(code: string, arch: "c" | "aarch64"): string {
	if (arch === "c") {
		const start = code.indexOf("int main(");
		expect(start).toBeGreaterThanOrEqual(0);
		return code.slice(start);
	}
	const start = code.indexOf("_main:");
	expect(start).toBeGreaterThanOrEqual(0);
	const end = code.indexOf("\n.p2align", start);
	return code.slice(start, end === -1 ? undefined : end);
}

describe("composed const strings fold to one literal", () => {
	test("aarch64 use site emits no string_add chain", () => {
		const result = build_code(
			`
import System

pub const A = "abc"
pub const B = A + "def"
pub const C = B + "ghi"

func use = (string s, out int) {
	return s.length
}

pub func main = () {
	Console.write_line(use(C).to_string())
}
`,
			"aarch64",
		);
		// The library's own internals may call string_add; only main's body
		// must be chain-free — the whole point of the fold.
		expect(main_body(result.code, "aarch64")).not.toContain("string_add");
	});

	test("C use site splices the merged literal", () => {
		const result = build_code(
			`
import System

pub const GREETING = "hel" + "lo"

pub func main = () {
	Console.write_line(GREETING)
}
`,
			"c",
		);
		const body = main_body(result.code, "c");
		expect(body).toContain("hello");
		expect(body).not.toContain("string_add");
	});

	test("folded const equals the composed value on both backends", async () => {
		for (const arch of ["c", "aarch64"] as const) {
			const parsed = parse(
				`
import System

pub const PART_A = "x:"
pub const PART_B = PART_A + "y"

pub func main = () {
	Console.write_line(PART_B + "z")
}
`,
				system,
				undefined,
				{ allow_internal: true },
			);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch, audit: false });
			await check_output(`const_string_fold_${arch}`, result, "x:yz\n", {
				arch,
				audit: false,
			});
		}
	});

	test("hex escape at a part boundary keeps its 2-digit cap", async () => {
		// "\\x41" is byte 0x41 ('A'); a following '4' is ordinary text. The
		// merged token "\"\\x414\"" must decode A then 4 — the escape cap and
		// the emitters' octal re-encoding keep the boundary intact.
		for (const arch of ["c", "aarch64"] as const) {
			const parsed = parse(
				`
import System

pub const HEX = "\\x41"
pub const JOINED = HEX + "4"

pub func main = () {
	Console.write_line(JOINED + "\\{JOINED.length}")
}
`,
				system,
				undefined,
				{ allow_internal: true },
			);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch, audit: false });
			await check_output(`const_string_fold_escape_${arch}`, result, "A42\n", {
				arch,
				audit: false,
			});
		}
	});

	test("a chain with a runtime operand still builds unfolded", async () => {
		for (const arch of ["c", "aarch64"] as const) {
			const parsed = parse(
				`
import System

pub const LIT = "n="

pub func main = () {
	var string suffix = "7"
	Console.write_line(LIT + suffix)
}
`,
				system,
				undefined,
				{ allow_internal: true },
			);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch, audit: false });
			await check_output(`const_string_fold_runtime_${arch}`, result, "n=7\n", {
				arch,
				audit: false,
			});
		}
	});
});
