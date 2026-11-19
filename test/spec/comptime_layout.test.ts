import { expect, test } from "vite-plus/test";

import { compile_main } from "./_helpers.ts";
// SPEC.md, "Layout Introspection" — one test per fenced code block. Every
// block pins the compile target so the fold is deterministic regardless of
// host (sizes follow the target ABI for fixed-array fields).
test("size_of/offset_of fold from the packed layout", () => {
	const body = `
		struct Pair {
			var int64 a
			var int32 b
		}
		const PAIR_BYTES = META.size_of(Pair)
		func probe = () {
			if META.offset_of(Pair, "b") == 16 {
				Console.write_line("b follows a")
			}
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("offset_of composes with field.name inside a #for arm", () => {
	const body = `
		struct Pair {
			var int64 a
			var int32 b
		}
		func dump = () {
			#for field of META.info(Pair).fields {
				if META.offset_of(Pair, field.name) >= 8 {
					Console.write_line(field.name)
				}
			}
		}
	`;
	expect(compile_main(body, { arch: "c", platform: "macos" })).toEqual([]);
});

test("offset_of over a missing field errors naming the type", () => {
	const body = `
		struct Point {
			var x = 0
			var y = 0
		}
		func probe = () {
			var a = META.offset_of(Point, "z")
		}
	`;
	const errors = compile_main(body, { arch: "c", platform: "macos" });
	expect(errors.some((e) => e.message === "META.offset_of: type 'Point' has no field 'z'")).toBe(
		true,
	);
});
