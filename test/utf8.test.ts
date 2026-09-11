import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("Utf8 decode_at", () => {
	test("decodes 1- to 4-byte sequences", async () => {
		const input = `
const d1 = Utf8.decode_at("A", 0)
Console.write("\\{d1.code_point} \\{d1.byte_length}\\n")
const e2 = "caf\\xC3\\xA9"
const d2 = Utf8.decode_at(e2, 3)
Console.write("\\{d2.code_point} \\{d2.byte_length}\\n")
const e3 = "\\xE2\\x82\\xAC"
const d3 = Utf8.decode_at(e3, 0)
Console.write("\\{d3.code_point} \\{d3.byte_length}\\n")
const e4 = "\\xF0\\x9F\\x98\\x80"
const d4 = Utf8.decode_at(e4, 0)
Console.write("\\{d4.code_point} \\{d4.byte_length}\\n")
`;
		await build_and_check_output(input, "utf8_decode_widths", "65 1\n233 2\n8364 3\n128512 4\n");
	});

	test("malformed sequences yield U+FFFD with length 1", async () => {
		const input = `
var sb = StringBuilder()
sb.append_char((0x61 as char))
sb.append_char((0x80 as char))
sb.append_char((0x62 as char))
const stray_src = sb.to_string()
const stray = Utf8.decode_at(stray_src, 1)
Console.write("\\{stray.code_point} \\{stray.byte_length}\\n")
const trunc = Utf8.decode_at("a\\xC3", 1)
Console.write("\\{trunc.code_point} \\{trunc.byte_length}\\n")
const overlong = Utf8.decode_at("\\xC0\\xAF", 0)
Console.write("\\{overlong.code_point} \\{overlong.byte_length}\\n")
const surrogate = Utf8.decode_at("\\xED\\xA0\\x80", 0)
Console.write("\\{surrogate.code_point} \\{surrogate.byte_length}\\n")
const past_max = Utf8.decode_at("\\xF5\\x80\\x80\\x80", 0)
Console.write("\\{past_max.code_point} \\{past_max.byte_length}\\n")
`;
		await build_and_check_output(
			input,
			"utf8_decode_malformed",
			"65533 1\n65533 1\n65533 1\n65533 1\n65533 1\n",
		);
	});

	test("width_at and char_count walk mixed text", async () => {
		const input = `
var sb = StringBuilder()
sb.append_char((0x61 as char))
sb.append_char((0xC3 as char))
sb.append_char((0xA9 as char))
sb.append_char((0xE2 as char))
sb.append_char((0x82 as char))
sb.append_char((0xAC as char))
sb.append_char((0xF0 as char))
sb.append_char((0x9F as char))
sb.append_char((0x98 as char))
sb.append_char((0x80 as char))
sb.append_char((0x62 as char))
const text = sb.to_string()
var int pos = 0
while pos < text.length {
	Console.write("\\{Utf8.width_at(text, pos)} ")
	pos = pos + Utf8.width_at(text, pos)
}
Console.write("\\n\\{Utf8.char_count(text)} \\{text.length}\\n")
`;
		await build_and_check_output(input, "utf8_widths_count", "1 2 3 4 1 \n5 11\n");
	});
});

describe("Utf8 encode", () => {
	test("encodes boundary code points and clamps invalid ones", async () => {
		const input = `
Console.write("\\{Utf8.encode(0x41).length} ")
Console.write("\\{Utf8.encode(0x7F).length} ")
Console.write("\\{Utf8.encode(0x80).length} ")
Console.write("\\{Utf8.encode(0x7FF).length} ")
Console.write("\\{Utf8.encode(0x800).length} ")
Console.write("\\{Utf8.encode(0xFFFF).length} ")
Console.write("\\{Utf8.encode(0x10000).length} ")
Console.write("\\{Utf8.encode(0x10FFFF).length}\\n")
const bad = Utf8.encode(0x110000)
const bd = Utf8.decode_at(bad, 0)
Console.write("\\{bd.code_point} \\{bad.length}\\n")
const half = Utf8.encode(0xD800)
const hd = Utf8.decode_at(half, 0)
Console.write("\\{hd.code_point} \\{half.length}\\n")
`;
		await build_and_check_output(
			input,
			"utf8_encode_lengths",
			"1 1 2 2 3 3 4 4\n65533 3\n65533 3\n",
		);
	});

	test("decode(encode(x)) round-trips", async () => {
		const input = `
var List<int> points = List<int>()
// NOTE: 0x0 excluded — the C backend cannot round-trip an embedded NUL
// (C-string truncation); aarch64 handles it.
points.push(0x1)
points.push(0x7F)
points.push(0x80)
points.push(0x7FF)
points.push(0x800)
points.push(0x20AC)
points.push(0xFFFF)
points.push(0x10000)
points.push(0x1F600)
points.push(0x10FFFF)
var int i = 0
while i < points.length {
	const enc = Utf8.encode(points.at_or_panic(i))
	const back = Utf8.decode_at(enc, 0)
	if back.code_point == points.at_or_panic(i) {
		Console.write("ok ")
	} else {
		Console.write("FAIL ")
	}
	i = i + 1
}
Console.write("\\n")
`;
		await build_and_check_output(input, "utf8_round_trip", "ok ok ok ok ok ok ok ok ok ok \n");
	});
});

describe("Chars cursor", () => {
	test("iterates code points and reports exhaustion", async () => {
		const input = `
var cur = Chars("a\\xC3\\xA9\\xE2\\x82\\xAC")
var int total = 0
while cur.has_next() {
	total = total + cur.next()
}
Console.write("\\{total} \\{cur.has_next()}\\n")
`;
		await build_and_check_output(input, "chars_iterate", "8694 false\n");
	});

	test("malformed bytes surface as U+FFFD without stalling", async () => {
		const input = `
var cur = Chars("\\x80\\xC3")
var int n = 0
var int total = 0
while cur.has_next() {
	total = total + cur.next()
	n = n + 1
}
Console.write("\\{n} \\{total}\\n")
`;
		await build_and_check_output(input, "chars_malformed", "2 131066\n");
	});
});

describe("CharIndex", () => {
	test("mixed-width text maps both directions", async () => {
		const input = `
var sb = StringBuilder()
sb.append_char((0x61 as char))
sb.append_char((0xE2 as char))
sb.append_char((0x82 as char))
sb.append_char((0xAC as char))
sb.append_char((0x62 as char))
sb.append_char((0x63 as char))
sb.append_char((0xF0 as char))
sb.append_char((0x9F as char))
sb.append_char((0x98 as char))
sb.append_char((0x80 as char))
sb.append_char((0x64 as char))
const text = sb.to_string()
const idx = CharIndex(text)
Console.write("\\{idx.char_count} \\{idx.runs.length}\\n")
Console.write("\\{idx.byte_offset_of(0)} \\{idx.byte_offset_of(1)} ")
Console.write("\\{idx.byte_offset_of(2)} \\{idx.byte_offset_of(3)} ")
Console.write("\\{idx.byte_offset_of(4)} \\{idx.byte_offset_of(5)}\\n")
Console.write("\\{idx.char_index_of(0)} \\{idx.char_index_of(1)} ")
Console.write("\\{idx.char_index_of(2)} \\{idx.char_index_of(4)} ")
Console.write("\\{idx.char_index_of(5)} \\{idx.char_index_of(6)} ")
Console.write("\\{idx.char_index_of(9)} \\{idx.char_index_of(10)} ")
Console.write("\\{idx.char_index_of(11)}\\n")
Console.write("\\{idx.char_at(0)} \\{idx.char_at(1)} \\{idx.char_at(4)}\\n")
`;
		await build_and_check_output(
			input,
			"charindex_mixed",
			"6 2\n0 1 4 5 6 10\n0 1 1 2 3 4 4 5 6\n97 8364 128512\n",
		);
	});

	test("ascii text needs no runs", async () => {
		const input = `
const idx = CharIndex("hello")
Console.write("\\{idx.char_count} \\{idx.runs.length} ")
Console.write("\\{idx.byte_offset_of(3)} \\{idx.char_index_of(2)} ")
Console.write("\\{idx.char_at(1)}\\n")
`;
		await build_and_check_output(input, "charindex_ascii", "5 0 3 2 101\n");
	});

	test("empty text indexes trivially", async () => {
		const input = `
const idx = CharIndex("")
Console.write("\\{idx.char_count} \\{idx.runs.length} \\{idx.char_index_of(0)}\\n")
`;
		await build_and_check_output(input, "charindex_empty", "0 0 0\n");
	});
});
