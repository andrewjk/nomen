import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import { parse_program } from "./parse_with_imports";
import { compile_module } from "./spec/_helpers.ts";

// Deep payload splices (the stage-6 residual): a case binding exposes
// `.param_count` and `.params[i]` (each with `.name` and `.type`), and a
// generated case's payload params take `#{...}` splices — the whole source
// param (`#{c.params[0]}`, type and name verbatim) or its slots
// (`#{c.params[0].type}` / `#{c.params[0].type.name}` in the type slot,
// `#{c.params[0].name}` in the name slot). One enum becomes a
// payload-preserving alias of another.

test("whole-param splices mirror a payload case", () => {
	const body = `
		mv enum Shape {
			case point(int x, int y)
		}
		mv enum Mirror {
			#for c of META.info(Shape).cases {
				case #{c.name}(#{c.params[0]}, #{c.params[1]})
			}
		}
		pub func main = () {
			var Mirror.point m = Mirror.point(3, 4)
			match m {
				case .point(px, py) {
					Console.write_line("point \\{px},\\{py}")
				}
			}
		}
	`;
	expect(compile_module(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("type and name slot splices compose a custom payload", () => {
	const body = `
		mv enum Shape {
			case tag(int code)
		}
		mv enum Mirror {
			#for c of META.info(Shape).cases {
				case #{c.name}(#{c.params[0].type} #{c.params[0].name})
			}
		}
		pub func main = () {
			var Mirror.tag m = Mirror.tag(7)
			match m {
				case .tag(c) {
					Console.write_line("tag \\{c}")
				}
			}
		}
	`;
	expect(compile_module(body, { arch: "c", platform: "macos" })).toEqual([]);
	// `.type.name` (the type's name as a comptime string) composes the same
	// way — the item's original spelling.
	const by_name = `
		mv enum Shape {
			case tag(int code)
		}
		mv enum MirrorByName {
			#for c of META.info(Shape).cases {
				case #{c.name}(#{c.params[0].type.name} #{c.params[0].name})
			}
		}
		pub func main = () {
			var MirrorByName.tag m = MirrorByName.tag(7)
			Console.write_line("ok")
		}
	`;
	expect(compile_module(by_name, { arch: "c", platform: "macos" })).toEqual([]);
});

test("a fixed type mixes with a spliced name", () => {
	const body = `
		mv enum Shape {
			case tag(int code)
		}
		mv enum Mirror {
			#for c of META.info(Shape).cases {
				case #{c.name}(string kind, #{c.params[0].type} #{c.params[0].name})
			}
		}
		pub func main = () {
			var Mirror.tag m = Mirror.tag(1, 7)
			Console.write_line("ok")
		}
	`;
	expect(compile_module(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("param_count is a comptime int at body scope", () => {
	const body = `
		enum Shape {
			case point(int x, int y)
			case unit
		}
		pub func main = () {
			#for c of META.info(Shape).cases {
				if c.param_count == 2 {
					Console.write_line(c.name + " has two")
				}
			}
		}
	`;
	expect(compile_module(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("an out-of-range payload index is a loud error", () => {
	const errors = compile_module(`
		mv enum Shape {
			case only(int a)
		}
		mv enum Bad {
			#for c of META.info(Shape).cases {
				case #{c.name}(#{c.params[0]}, #{c.params[1]})
			}
		}
		pub func main = () {}
	`);
	expect(
		errors.some((e) =>
			e.message.includes("case 'only' has 1 payload param(s); params[1] is out of range"),
		),
	).toBe(true);
});

test("payload splices over a non-cases iterable are an error", () => {
	const errors = compile_module(`
		struct S {
			var x = 0
		}
		mv enum Bad {
			#for f of META.info(S).fields {
				case #{f.name}(#{f.params[0]})
			}
		}
		pub func main = () {}
	`);
	expect(errors.some((e) => e.message.includes("payload splices iterate META.info(E).cases"))).toBe(
		true,
	);
});

test("a whole-param path in the name slot is an error spelling the fix", () => {
	const errors = compile_module(`
		mv enum Shape {
			case tag(int code)
		}
		mv enum Bad {
			#for c of META.info(Shape).cases {
				case #{c.name}(int #{c.params[0]})
			}
		}
		pub func main = () {}
	`);
	expect(
		errors.some((e) =>
			e.message.includes("resolves to a param — the payload NAME slot needs #{c.params[i].name}"),
		),
	).toBe(true);
});

test("generated payload cases construct and match end to end", async () => {
	for (const arch of ["aarch64", "c"] as const) {
		const parsed = parse_program(
			`import System
mv enum Shape {
	case point(int x, int y)
	case size(int w, int h)
}
mv enum Mirror {
	#for c of META.info(Shape).cases {
		case #{c.name}(#{c.params[0]}, #{c.params[1]})
	}
}
pub func main = () {
	var Mirror.point p = Mirror.point(3, 4)
	match p {
		case .point(px, py) {
			Console.write_line("point \\{px},\\{py}")
		}
	}
	var Mirror.size s = Mirror.size(30, 40)
	match s {
		case .size(w, h) {
			Console.write_line("size \\{w}x\\{h}")
		}
	}
}
`,
			{ arch },
		);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch, audit: true });
		expect(result.errors ?? []).toEqual([]);
		await check_output(`case_params_${arch}`, result, "point 3,4\nsize 30x40\n", {
			arch,
			audit: true,
		});
	}
});
