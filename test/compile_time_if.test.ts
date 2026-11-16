import path from "node:path";

import { expect, test } from "vitest";

import build from "../src/build.ts";
import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

function parse_src(source: string, options?: { arch?: string; platform?: string }) {
	return parse(`import System\n${source}`, system, undefined, {
		allow_internal: true,
		allow_user_raw: true,
		...options,
	});
}

test("#switch: only the matching arm survives to the tree", () => {
	const parsed = parse_src(
		`
		#switch {
			case META.arch == "aarch64" { func target_helper = (out int) { return 1 } }
			case META.arch == "c" { func target_helper = (out int) { return 2 } }
		} else { func target_helper = (out int) { return 3 } }
		`,
		{ arch: "c", platform: "macos" },
	);
	expect(parsed.errors).toEqual([]);
	// Exactly ONE helper survives (the c case); the other arms are gone.
	const helpers = parsed.root.statements.filter(
		(s) => s.node_type === "func" && (s as any).name === "target_helper",
	);
	expect(helpers.length).toBe(1);
});

test("no matching arm and no else removes everything", () => {
	const parsed = parse_src(
		`
		func keep = () {}
		#if META.platform == "windows" {
			func gone = () {}
		}
		`,
		{ arch: "c", platform: "macos" },
	);
	expect(parsed.errors).toEqual([]);
	const user_funcs = parsed.root.statements.filter(
		(s) => s.node_type === "func" && !(s as any).is_library,
	);
	expect(user_funcs.map((s) => (s as any).name)).toEqual(["keep"]);
});

test("dead arms are not checked — missing names are fine there", () => {
	const parsed = parse_src(
		`
		func f = () {
			#switch {
				case META.arch == "c" {
					var x = 1
					Console.write_line("{x}")
				}
				case META.arch == "aarch64" {
					// Only reached on aarch64: the name below exists nowhere on
					// the c target — checking it would be a spurious error.
					this_function_does_not_exist(1, 2)
				}
			}
		}
		`,
		{ arch: "c", platform: "macos" },
	);
	expect(parsed.errors).toEqual([]);
});

test("mutually exclusive same-name declarations do not collide", () => {
	// Per-target implementations of one function — the flagship shape. The
	// duplicate-name check must run on the FOLDED tree, not the raw one.
	const parsed = parse_src(
		`
		#switch {
			case META.arch == "c" { func hash8 = (int v, out int) { return v & 255 } }
			case META.arch == "aarch64" { func hash8 = (int v, out int) { return v } }
		}
		`,
		{ arch: "aarch64", platform: "macos" },
	);
	expect(parsed.errors).toEqual([]);
});

test("live code may use a declaration selected by a pragma", () => {
	const parsed = parse_src(
		`
		#if META.platform == "macos" {
			struct HostInfo {
				pub var int tag
			}
		}
		#if META.platform == "linux" {
			struct HostInfo {
				pub var int tag
			}
		}
		pub func main = () {
			var h = HostInfo(7)
			Console.write_line("{h.tag}")
		}
		`,
		{ arch: "c", platform: "macos" },
	);
	expect(parsed.errors).toEqual([]);
});

test("conditions compose with && || ! and parentheses", () => {
	const source = `
		func f = () {
			#if (META.arch == "c" || META.arch == "aarch64") && !(META.platform == "windows") {
				var x = 1
				Console.write_line("{x}")
			}
		}
	`;
	const parsed = parse_src(source, { arch: "c", platform: "macos" });
	expect(parsed.errors).toEqual([]);
	// The compound condition is FALSE for windows — the else arm lives then.
	const win = parse_src(
		`
		func f = () {
			#if (META.arch == "c" || META.arch == "aarch64") && !(META.platform == "windows") {
				var x = 1
				Console.write_line("{x}")
			} else {
				var y = 2
				Console.write_line("{y}")
			}
		}
		`,
		{ arch: "c", platform: "windows" },
	);
	expect(win.errors).toEqual([]);
});

test("unknown META field is an error", () => {
	const parsed = parse_src(`#if META.os == "macos" { }`, { arch: "c", platform: "macos" });
	expect(parsed.errors.length).toBe(1);
	expect(parsed.errors[0].message).toContain("Unknown META field 'META.os'");
});

test("non-constant operators are rejected with the supported grammar", () => {
	const parsed = parse_src(`#if 1 + 1 == 2 { }`, { arch: "c", platform: "macos" });
	expect(parsed.errors.length).toBe(1);
	expect(parsed.errors[0].message).toContain("Unsupported #if condition operator '+'");
});

test("comparing a string with a bool is an error", () => {
	const parsed = parse_src(`#if META.arch == true { }`, { arch: "c", platform: "macos" });
	expect(parsed.errors.length).toBe(1);
	expect(parsed.errors[0].message).toContain("compares a string with a bool");
});

test("#elif no longer exists — the # dispatch rejects it", () => {
	const parsed = parse_src(
		`
		func f = () {
			#if META.arch == "c" {
				var x = 1
			} #elif META.arch == "aarch64" {
				var y = 2
			}
		}
		`,
		{ arch: "c", platform: "macos" },
	);
	expect(parsed.errors.some((e) => e.message.includes("Expected #if, #switch"))).toBe(true);
});

test("#switch else arms sit outside the case braces", () => {
	const parsed = parse_src(
		`
		func f = () {
			#switch {
				case META.arch == "c" {
					var x = 1
				} else {
					var y = 2
				}
			}
		}
		`,
		{ arch: "c", platform: "macos" },
	);
	expect(
		parsed.errors.some((e) => e.message.includes("else arms sit outside the case braces")),
	).toBe(true);
});

test("#switch case arms accept the -> one-line form", () => {
	const parsed = parse_src(
		`
		func f = () {
			#switch {
				case META.arch == "c" -> Console.write_line("c")
				case META.arch == "aarch64" -> Console.write_line("arm")
			} else -> Console.write_line("other")
		}
		`,
		{ arch: "c", platform: "macos" },
	);
	expect(parsed.errors).toEqual([]);
});

test("pragmas nest inside pragma arms", () => {
	const parsed = parse_src(
		`
		func f = () {
			#if META.arch == "c" {
				#if META.platform == "macos" {
					var x = "c/macos"
					Console.write_line(x)
				} else {
					var y = "c/other"
					Console.write_line(y)
				}
			}
		}
		`,
		{ arch: "c", platform: "macos" },
	);
	expect(parsed.errors).toEqual([]);
});

test("a pragma inside a struct body is rejected (stage-1 limit)", () => {
	const parsed = parse_src(
		`
		struct S {
			#if META.arch == "c" {
				pub var int x
			}
		}
		`,
		{ arch: "c", platform: "macos" },
	);
	expect(parsed.errors.some((e) => e.message.includes("cannot appear here"))).toBe(true);
});

test("raw blocks inside #switch arms select per target", () => {
	const parsed = parse_src(
		`
		func raw_probe = () {
			#switch {
				case META.arch == "c" {
				\`\`\`
				#c_target_marker
				\`\`\`
				}
				case META.arch == "aarch64" {
				\`\`\`
				#arm_target_marker
				\`\`\`
				}
			}
		}
		`,
		{ arch: "c", platform: "macos" },
	);
	expect(parsed.errors).toEqual([]);
	// The folded tree must contain only the c case's raw block.
	const func = parsed.root.statements.find((s) => s.node_type === "func") as any;
	const raws = func.statements.filter((s: any) => s.node_type === "raw");
	expect(raws.length).toBe(1);
	expect(raws[0].value).toContain("#c_target_marker");
});

test("defaults mirror build(): the C backend and the host platform", () => {
	const parsed = parse_src(
		`
		func f = () {
			#if META.arch == "c" {
				var x = 1
			}
		}
		`,
	);
	expect(parsed.errors).toEqual([]);
});

test("both backends build the folded tree per target", () => {
	const source = `
		import System
		func pick = (out string) {
			#switch {
				case META.arch == "c" { return "c side" }
				case META.arch == "aarch64" { return "arm side" }
			}
		}
		pub func main = () {
			Console.write_line(pick())
		}
	`;
	const c_tree = parse(source, system, undefined, {
		allow_internal: true,
		arch: "c",
		platform: "linux",
	});
	expect(c_tree.errors).toEqual([]);
	const c_built = build(c_tree.root, { arch: "c", platform: "linux" });
	expect(c_built.errors ?? []).toEqual([]);
	expect(c_built.code).toContain("c side");

	const arm_tree = parse(source, system, undefined, {
		allow_internal: true,
		arch: "aarch64",
		platform: "macos",
	});
	expect(arm_tree.errors).toEqual([]);
	const arm_built = build(arm_tree.root, { arch: "aarch64", platform: "macos" });
	expect(arm_built.errors ?? []).toEqual([]);
	expect(arm_built.code).toContain("arm side");
	expect(arm_built.code).not.toContain("c side");
});
