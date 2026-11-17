import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { parse_raw } from "./parse_with_imports";

// `#raw { ... }` — the raw-block syntax (AGENTS.md "Inline code blocks").
// Target selection is the `#if` fold; the opener carries the block's own
// dialect (`"c"` = companion-C) and scope (`"file"`).

describe("raw block syntax", () => {
	test("bare #raw parses with default dialect and block scope", () => {
		const parsed = parse_raw(`
import System

func f = (out int) {
	#raw {
		return 42;
	}
}
`);
		expect(parsed.errors).toEqual([]);
		const fn = parsed.root.statements.find(
			(s) => s.node_type === "func" && (s as { name?: string }).name === "f",
		);
		const raw = (
			fn as unknown as {
				statements: { node_type: string; is_c?: boolean; scope?: string }[];
			}
		).statements[0];
		expect(raw.node_type).toBe("raw");
		expect(raw.is_c).toBe(false);
		expect(raw.scope).toBe("block");
	});

	test('#raw("c") marks companion-C; #raw("c", "file") also sets file scope', () => {
		const parsed = parse_raw(`
import System

func f_c = (out int) {
	#raw("c") {
		return 1;
	}
}

func f_c_file = (out int) {
	#raw("c", "file") {
		#include <stdio.h>
	}
	#raw("c") {
		return 1;
	}
}

func f_file = (out int) {
	#raw("file") {
		static int counter = 0;
	}
	#raw {
		return 2;
	}
}
`);
		expect(parsed.errors).toEqual([]);
		const flags = (name: string) => {
			const fn = parsed.root.statements.find(
				(s) => s.node_type === "func" && (s as { name?: string }).name === name,
			);
			const raw = (
				fn as unknown as {
					statements: { node_type: string; is_c?: boolean; scope?: string }[];
				}
			).statements.find((s) => s.node_type === "raw");
			return [raw?.is_c, raw?.scope];
		};
		expect(flags("f_c")).toEqual([true, "block"]);
		expect(flags("f_c_file")).toEqual([true, "file"]);
		expect(flags("f_file")).toEqual([false, "file"]);
	});

	test("braces inside strings and comments do not close the body", () => {
		const parsed = parse_raw(`
import System

func f = (out int) {
	#raw {
		// release it { and zero the fields }
		const char* enc = "v@:@@{NSSize=dd}";
		if (enc) { return 7; }
		return 0;
	}
}
`);
		expect(parsed.errors).toEqual([]);
		const fn = parsed.root.statements.find(
			(s) => s.node_type === "func" && (s as { name?: string }).name === "f",
		);
		const raw = (fn as unknown as { statements: { value?: string }[] }).statements[0];
		// The whole body survived — the trailing `return 0;` is inside it.
		expect(raw.value).toContain("NSSize=dd");
		expect(raw.value).toContain("return 0;");
		expect(raw.value).not.toContain("#raw");
	});

	test("#raw inside an #if arm folds per target and builds on C", () => {
		const parsed = parse_raw(
			`
import System

func answer = (out int) {
	#if META.arch == "c" {
		#raw {
			return 42;
		}
	}
	return 0
}

pub func main = () {
	Console.write("\\{answer()}")
}
`,
			{ arch: "c" },
		);
		expect(parsed.errors).toEqual([]);
		const built = build(parsed.root, { arch: "c", audit: false });
		expect(built.errors ?? []).toEqual([]);
		expect(built.code).toContain("return 42;");
	});

	test("a raw-only function on the js target has no implementation error", () => {
		// Raw arms are target-explicit (no `else`): on `js` neither arm
		// matches, and the JS backend consumes neither dialect — the
		// "no implementation for this target" guard is exempt there.
		const parsed = parse_raw(
			`
import System

func answer = (out int) {
	#if META.arch == "c" {
		#raw {
			return 1;
		}
	}
	#if META.arch == "aarch64" {
		#raw {
			mov x0, #2
			ret
		}
	}
}
`,
			{ arch: "js" },
		);
		expect(parsed.errors).toEqual([]);
	});

	test("a raw-only function whose every arm folded away has no implementation", () => {
		// The stage-5 coverage guard: the arms target aarch64 only, so on the
		// C target the body folds to nothing and callers would call into
		// nothing — a check-time error pointing at the missing arm.
		const parsed = parse_raw(
			`
import System

func answer = (out int) {
	#if META.arch == "aarch64" {
		#raw {
			mov x0, #2
			ret
		}
	}
}
`,
			{ arch: "c" },
		);
		expect(
			parsed.errors.some((e) => e.message.includes("has no implementation for this target")),
		).toBe(true);
		// The error points at the CURRENT target's missing arm spelling.
		expect(parsed.errors.some((e) => e.message.includes('META.arch == "c"'))).toBe(true);
	});

	test("mixed statements with an other-target raw arm check clean", () => {
		// The tag era rejected any function whose raw blocks all targeted a
		// different arch, even when the body had ordinary statements. Under
		// the `#if` fold the arm vanishes (code for other targets disappears
		// without a trace) and the Nomen statements check normally — the
		// "no implementation" guard only covers the raw-ONLY shape, where
		// nothing else is left.
		const parsed = parse_raw(
			`
import System

func tagged = (out int) {
	var base = 40
	#if META.arch == "c" {
		#raw {
			printf("only on C\\n");
		}
	}
	return base + 2
}

pub func main = () {
	Console.write_line(tagged().to_string())
}
`,
			{ arch: "aarch64" },
		);
		expect(parsed.errors).toEqual([]);
	});

	test("an unsupported argument is rejected", () => {
		const parsed = parse_raw(`
import System

func f = (out int) {
	#raw("asm") {
		return 1;
	}
}
`);
		expect(parsed.errors.some((e) => e.message.includes("Unsupported #raw argument"))).toBe(true);
	});

	test("the legacy ``` fence is rejected with a migration message", () => {
		const parsed = parse_raw(
			"import System\n\nfunc f = (out int) {\n\t```\n\treturn 1;\n\t```\n}\n",
		);
		expect(parsed.errors.some((e) => e.message.includes("raw blocks now use '#raw"))).toBe(true);
	});

	test("legacy #c / #scope: header lines are rejected", () => {
		const with_header = parse_raw(`
import System

func f = (out int) {
	#raw {
		#c
		return 1;
	}
}
`);
		expect(with_header.errors.some((e) => e.message.includes("header lines are gone"))).toBe(true);
	});

	test("legacy #arch: tags are rejected inside a #raw body", () => {
		const parsed = parse_raw(`
import System

func f = (out int) {
	#raw {
		#arch: c
		return 1;
	}
}
`);
		expect(parsed.errors.some((e) => e.message.includes("no longer take '#arch:'"))).toBe(true);
	});

	test("#raw still rejects user code without the machinery opt-in", () => {
		// parse_raw's helper sets allow_user_raw; the lockdown itself is
		// pinned by test/unsafe.test.ts. This just pins the error shape here.
		const parsed = parse_raw(`
import System

func f = (out int) {
	#raw {
		return 1;
	}
}
`);
		expect(parsed.errors).toEqual([]);
	});
});
