import { expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./spec/_helpers.ts";

// Layout introspection (COMPTIME.md stage 7): META.size_of(T),
// META.align_of(T) and META.offset_of(T, "field") fold to comptime ints
// from the SAME layout walk the backends lay out with
// (build_common/layout.ts).
//
// The model: an 8-byte vtable word leads every struct value; fields follow
// in packed (alignment-descending) order, each aligned to its natural
// width; the total is tail-padded to 8. A dead `else` arm that names a
// nonexistent function proves the live arm was chosen by the folded value.

const C_TARGET = { arch: "c", platform: "macos" } as const;
const AARCH64_TARGET = { arch: "aarch64", platform: "macos" } as const;

test("size_of folds the packed struct layout", () => {
	// Packed order (alignment-descending): big, mid, flag —
	// big @8, mid @16, flag @20; total 21 → tail-padded to 24.
	const body = `
		struct Sample {
			var int64 big
			var bool flag
			var int32 mid
		}
		func probe = () {
			if META.size_of(Sample) == 24 {
				Console.write_line("size")
			} else {
				dead_wrong_size()
			}
		}
	`;
	expect(compile_main(body, C_TARGET)).toEqual([]);
});

test("offset_of folds each field's packed offset", () => {
	const body = `
		struct Sample {
			var int64 big
			var bool flag
			var int32 mid
		}
		func probe = () {
			if META.offset_of(Sample, "big") == 8 {
				Console.write_line("big")
			} else {
				dead_wrong_big()
			}
			if META.offset_of(Sample, "mid") == 16 {
				Console.write_line("mid")
			} else {
				dead_wrong_mid()
			}
			if META.offset_of(Sample, "flag") == 20 {
				Console.write_line("flag")
			} else {
				dead_wrong_flag()
			}
		}
	`;
	expect(compile_main(body, C_TARGET)).toEqual([]);
});

test("align_of returns natural alignment", () => {
	const body = `
		func probe = () {
			if META.align_of(bool) == 1 {
				Console.write_line("bool")
			} else {
				dead_bool()
			}
			if META.align_of(int32) == 4 {
				Console.write_line("int32")
			} else {
				dead_int32()
			}
			if META.align_of(int) == 8 {
				Console.write_line("int")
			} else {
				dead_int()
			}
			if META.align_of(string) == 8 {
				Console.write_line("string")
			} else {
				dead_string()
			}
		}
	`;
	expect(compile_main(body, C_TARGET)).toEqual([]);
});

test("scalars and strings fold to their storage widths", () => {
	const body = `
		func probe = () {
			if META.size_of(bool) == 1 {
				Console.write_line("bool")
			} else {
				dead_bool()
			}
			if META.size_of(char) == 1 {
				Console.write_line("char")
			} else {
				dead_char()
			}
			if META.size_of(int32) == 4 {
				Console.write_line("int32")
			} else {
				dead_int32()
			}
			if META.size_of(int) == 8 {
				Console.write_line("int")
			} else {
				dead_int()
			}
			if META.size_of(string) == 16 {
				Console.write_line("string")
			} else {
				dead_string()
			}
		}
	`;
	expect(compile_main(body, C_TARGET)).toEqual([]);
});

test("nested structs lay out inline; enums fold to tag + payload", () => {
	// Inner: vt + int32 → 12 → 16. Outer: inner @8, tag @24 → 32.
	// Mode (no payloads) is a tag word; Payload's int payload pads to 16.
	const body = `
		struct Inner {
			var int32 a
		}
		struct Outer {
			var Inner inner
			var int tag
		}
		enum Mode {
			case on
			case off
		}
		enum Payload {
			case fixed(int pixels)
		}
		func probe = () {
			if META.size_of(Inner) == 16 {
				Console.write_line("inner")
			} else {
				dead_inner()
			}
			if META.size_of(Outer) == 32 {
				Console.write_line("outer")
			} else {
				dead_outer()
			}
			if META.offset_of(Outer, "tag") == 24 {
				Console.write_line("tag")
			} else {
				dead_tag()
			}
			if META.size_of(Mode) == 8 {
				Console.write_line("mode")
			} else {
				dead_mode()
			}
			if META.size_of(Payload) == 16 {
				Console.write_line("payload")
			} else {
				dead_payload()
			}
		}
	`;
	expect(compile_main(body, C_TARGET)).toEqual([]);
});

test("nullable fields fold to their companion-flag layout", () => {
	// WithOpt: x @8; Point p @16 (24 bytes) + 8-byte _has flag → 48.
	// OptFlag: bool maybe @8 (1 byte) + 1-byte _has → 10 → 16.
	const body = `
		struct Point {
			var int x
			var int y
		}
		struct WithOpt {
			var int x
			var Point? p
		}
		struct OptFlag {
			var bool? maybe
		}
		func probe = () {
			if META.size_of(WithOpt) == 48 {
				Console.write_line("with_opt")
			} else {
				dead_with_opt()
			}
			if META.offset_of(WithOpt, "p") == 16 {
				Console.write_line("p")
			} else {
				dead_p()
			}
			if META.size_of(OptFlag) == 16 {
				Console.write_line("opt_flag")
			} else {
				dead_opt_flag()
			}
		}
	`;
	expect(compile_main(body, C_TARGET)).toEqual([]);
});

test("trait-declared fields join the conformer's layout", () => {
	// V: own x @8; trait tail tag (string, 16) @16 → 32.
	const body = `
		trait Tagged {
			mv tag = "trait-default"
		}
		struct V : Tagged {
			var x = 1
		}
		func probe = () {
			if META.size_of(V) == 32 {
				Console.write_line("size")
			} else {
				dead_size()
			}
			if META.offset_of(V, "tag") == 16 {
				Console.write_line("tag")
			} else {
				dead_tag()
			}
		}
	`;
	expect(compile_main(body, C_TARGET)).toEqual([]);
});

test("a folded size works as an ordinary int", () => {
	// Pair: a @8, b @16 → 24 (3 words). The comptime ints compose with the
	// ordinary arithmetic both at file scope (a const initializer) and in a
	// runtime expression.
	const body = `
		struct Pair {
			var int64 a
			var int32 b
		}
		const int WORDS = META.size_of(Pair) / 8
		func probe = () {
			var bytes = META.size_of(Pair) * 2
			if WORDS == 3 && bytes == 48 {
				Console.write_line("ok")
			}
		}
		pub func main = () {
			probe()
		}
	`;
	expect(compile_module(body, C_TARGET)).toEqual([]);
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
				} else {
					dead_negative_offset()
				}
			}
		}
	`;
	expect(compile_main(body, C_TARGET)).toEqual([]);
});

test("size_of(T) defers over a type parameter and folds per specialization", () => {
	// Item: vt + int64 → 16; int is one word. The generic declaration alone
	// never folds (T unbound) and never errors; each specialization folds
	// its own arm — the dead side (with its unknown call) is never checked.
	const body = `
		struct Item {
			var int64 id
		}
		func probe_wide = (type T, out string) {
			if META.size_of(T) == 16 {
				return "wide"
			} else {
				dead_not_wide()
			}
			return "word"
		}
		func probe_word = (type T, out string) {
			if META.size_of(T) == 16 {
				dead_too_wide()
			}
			return "word"
		}
		pub func main = () {
			Console.write_line(probe_wide(Item))
			Console.write_line(probe_word(int))
		}
	`;
	expect(compile_module(body)).toEqual([]);
});

test("size_of follows the target ABI for fixed-array fields", () => {
	// The one C/native divergence: a fixed stack-array field is a length
	// header + elements on aarch64 (8 + 32), an inline C array on the C
	// target (32). Buf: 48 native, 40 on C.
	const c_body = `
		struct Buf {
			var uint64[4] slots
		}
		func probe = () {
			if META.size_of(Buf) == 40 {
				Console.write_line("c")
			} else {
				dead_wrong_c_size()
			}
		}
	`;
	expect(compile_main(c_body, C_TARGET)).toEqual([]);
	const native_body = `
		struct Buf {
			var uint64[4] slots
		}
		func probe = () {
			if META.size_of(Buf) == 48 {
				Console.write_line("aarch64")
			} else {
				dead_wrong_native_size()
			}
		}
	`;
	expect(compile_main(native_body, AARCH64_TARGET)).toEqual([]);
});

test("a generic spelling is a compile error", () => {
	const errors = compile_module(`
		func probe = () {
			var a = META.size_of(List)
		}
	`);
	expect(
		errors.some((e) =>
			e.message.includes("META.size_of: 'List' is generic — reflect over a concrete instantiation"),
		),
	).toBe(true);
});

test("offset_of over a missing field is a compile error", () => {
	const errors = compile_module(`
		struct Point {
			var x = 0
			var y = 0
		}
		func probe = () {
			var a = META.offset_of(Point, "z")
		}
	`);
	expect(errors.some((e) => e.message.includes("'Point' has no field 'z'"))).toBe(true);
});

test("wrong arity reports the spelling that works", () => {
	const errors = compile_module(`
		func probe = () {
			var a = META.size_of()
		}
	`);
	expect(errors.some((e) => e.message.includes("META.size_of takes a type name"))).toBe(true);

	const offset_errors = compile_module(`
		struct Point {
			var x = 0
		}
		func probe = () {
			var a = META.offset_of(Point)
		}
	`);
	expect(
		offset_errors.some((e) => e.message.includes(`META.offset_of takes a type and a field name`)),
	).toBe(true);

	const field_errors = compile_module(`
		struct Point {
			var x = 0
		}
		func probe = () {
			var a = META.offset_of(Point, 42)
		}
	`);
	expect(
		field_errors.some((e) => e.message.includes(`META.offset_of takes a field name string`)),
	).toBe(true);
});
