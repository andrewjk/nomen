import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import { parse_program } from "./parse_with_imports";
import { compile_main } from "./spec/_helpers.ts";

// Nested `#for` (the stage-6 residual): a member loop inside a generated
// type's body — or a body loop inside another loop's arm — is left for its
// OWN expansion. The outer rewrite rewrites only the nested loop's iterable
// (it may reference the outer binding, `META.info(#t).fields`) and stamps
// the enclosing bindings on it; the inner expansion folds inner templates
// against the inner binding and outer references through the stamped stack.

test("a member loop nested in a generated struct expands against its own binding", () => {
	const body = `
		struct Base {
			var width = 0
		}
		#for w of META.info(Base).fields {
			mv struct S_#{w.name} {
				#for f of META.info(Base).fields {
					var #{f.name} = 0
				}
			}
		}
		pub func main = () {
			var s = S_width()
			Console.write_line("ok")
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("an inner arm composes with the outer binding (stack)", () => {
	// `w.name` (outer) and `f.name` (inner) fold per nested expansion — the
	// composed method returns "width/width".
	const body = `
		struct Base {
			var width = 0
		}
		#for w of META.info(Base).fields {
			mv struct S_#{w.name} {
				#for f of META.info(Base).fields {
					var #{f.name} = 0
					pub func describe_#{f.name} = (self, out string) {
						return w.name + "/" + f.name
					}
				}
			}
		}
		pub func main = () {
			var s = S_width()
			Console.write_line(s.describe_width())
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("nested generated members run end to end (file scope)", async () => {
	// A file-scope loop (declaration generation) whose generated structs
	// carry a nested member loop, run and printed on both backends. Built
	// directly (single TU) — the wrap-in-main harness would put the
	// declaration-generating loop at function scope, where a generated
	// struct's methods do not hoist.
	for (const arch of ["aarch64", "c"] as const) {
		const parsed = parse_program(
			`import System
struct Base {
	var width = 0
}
#for w of META.info(Base).fields {
	mv struct S_#{w.name} {
		#for f of META.info(Base).fields {
			var #{f.name} = 0
			pub func describe_#{f.name} = (self, out string) {
				return w.name + "/" + f.name
			}
		}
	}
}
pub func main = () {
	var s = S_width()
	Console.write_line(s.describe_width())
}
`,
			{ arch },
		);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch, audit: true });
		expect(result.errors ?? []).toEqual([]);
		await check_output(`nested_for_compose_${arch}`, result, "width/width\n", {
			arch,
			audit: true,
		});
	}
});

test("a nested loop's iterable may reference the outer binding", () => {
	// `META.info(#t)` — the type binding folds when the OUTER rewrite
	// touches the nested iterable, so the inner expansion resolves against
	// the concrete type.
	const body = `
		@entity
		struct User {
			var id = 0
		}
		#for t of META.types_with("entity") {
			mv struct Mirror_#{t.name} {
				#for f of META.info(#t).fields {
					var #{f.name} = 0
				}
			}
		}
		pub func main = () {
			var m = Mirror_User()
			Console.write_line("ok")
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("a generated enum's nested case loop composes both bindings", () => {
	const body = `
		enum Shape {
			case line
			case circle
		}
		#for w of ["a", "b"] {
			enum E_#{w} {
				#for c of META.info(Shape).cases {
					case #{c.name}_#{w}
				}
			}
		}
		pub func main = () {
			var e = E_a.line_a
			Console.write_line("ok")
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("body-scope nesting composes the value bindings", () => {
	const body = `
		#for w of ["a", "b"] {
			#for i of 0..2 {
				if #w == "a" && #i == 0 {
					Console.write_line("first")
				}
			}
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});
