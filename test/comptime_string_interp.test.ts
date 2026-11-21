import path from "node:path";

import { expect, test } from "vite-plus/test";

import build from "../src/build.ts";
import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

function parse_src(source: string, options?: { arch?: string; platform?: string }) {
	return parse(`import System\n${source}`, system, undefined, {
		allow_internal: true,
		...options,
	});
}

function build_c(source: string): string {
	const parsed = parse_src(source, { arch: "c", platform: "linux" });
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "c", platform: "linux" });
	expect(built.errors ?? []).toEqual([]);
	return built.code;
}

test("a field-name interpolation folds to one literal", () => {
	const code = build_c(`
		struct Point {
			var int x = 0
			var int y = 0
		}
		func probe = () {
			#for field of META.info(Point).fields {
				const msg = "decode_\\{field.name}"
				Console.write_line(msg)
			}
		}
	`);
	expect(code).toContain('"decode_x"');
	expect(code).toContain('"decode_y"');
	expect(code).not.toContain("_string_interpolate");
});

test("an interpolated comptime if condition folds the live arm", () => {
	const parsed = parse_src(`
		struct Point {
			var int x = 0
		}
		func probe = () {
			#for field of META.info(Point).fields {
				if "field_\\{field.name}" == "field_x" {
					Console.write_line(field.name)
				} else {
					this_dead_arm_must_not_check()
				}
			}
		}
	`);
	expect(parsed.errors).toEqual([]);
});

test("int bindings interpolate as their literal text", () => {
	const code = build_c(`
		func probe = () {
			#for i of 0..2 {
				const s = "v\\{#i}"
				Console.write_line(s)
			}
		}
	`);
	expect(code).toContain('"v0"');
	expect(code).toContain('"v1"');
	expect(code).not.toContain("_string_interpolate");
});

test("table string bindings interpolate", () => {
	const code = build_c(`
		func probe = () {
			#for w of ["get", "post"] {
				const s = "do_\\{#w}"
				Console.write_line(s)
			}
		}
	`);
	expect(code).toContain('"do_get"');
	expect(code).toContain('"do_post"');
	expect(code).not.toContain("_string_interpolate");
});

test("the fold composes with the + fold", () => {
	const code = build_c(`
		struct Point {
			var int x = 0
		}
		func probe = () {
			#for field of META.info(Point).fields {
				const s = "pre_" + "mid_\\{field.name}" + "_post"
				Console.write_line(s)
			}
		}
	`);
	expect(code).toContain('"pre_mid_x_post"');
	expect(code).not.toContain("_string_interpolate");
});

test("META.info(T).name and field_count interpolate", () => {
	const code = build_c(`
		struct Point {
			var int x = 0
			var int y = 0
		}
		func probe = () {
			const s = "\\{META.info(Point).name} has \\{META.info(Point).field_count}"
			Console.write_line(s)
		}
	`);
	expect(code).toContain('"Point has 2"');
	expect(code).not.toContain("_string_interpolate");
});

test("a runtime operand keeps the runtime call", () => {
	const code = build_c(`
		func probe = (string name) {
			Console.write_line("hi \\{name}")
		}
	`);
	expect(code).toContain("_string_interpolate_1");
});

test("a format spec keeps the runtime call", () => {
	const code = build_c(`
		func probe = () {
			#for i of 0..2 {
				Console.write_line("\\{#i:08x}")
			}
		}
	`);
	expect(code).toContain("_string_interpolate_1");
});

test("#error takes an interpolated comptime message", () => {
	const errors = parse_src(`
		struct Point {
			var int x = 0
		}
		func probe = () {
			#for field of META.info(Point).fields {
				#error "field \\{field.name} is not allowed here"
			}
		}
	`).errors;
	expect(errors.length).toBe(1);
	expect(errors[0].message).toBe("field x is not allowed here");
});

test("#error takes a META comptime message at file scope", () => {
	const errors = parse_src(`
		#error "reflecting over \\{META.info(Point).field_count} fields"
		struct Point {
			var int x = 0
		}
	`).errors;
	expect(errors.length).toBe(1);
	expect(errors[0].message).toBe("reflecting over 1 fields");
});

test("#error rejects a message that cannot fold", () => {
	const parsed = parse_src(`
		func probe = (string name) {
			#error "bad \\{name}"
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("must fold to a comptime string"))).toBe(
		true,
	);
});

test("#error still takes a plain literal", () => {
	const errors = parse_src(`#error "plain message"`).errors;
	expect(errors.length).toBe(1);
	expect(errors[0].message).toBe("plain message");
});
