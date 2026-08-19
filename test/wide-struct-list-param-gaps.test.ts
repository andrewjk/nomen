import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A multi-field value struct with a `string` field, stored in a List and
// passed to a function as a PARAMETER, is unsound when the callee loops
// `.at(i)` → copies the struct → reads the string field → passes it to
// another function:
//
// - under the audit leak detector BOTH backends LEAK one allocation per
//   element (the Buffer slot's own copy is never freed — `units 15` leaks
//   16 allocations),
// - in a plain (non-audit) build the C backend SIGSEGVs outright on
//   real-world-sized inputs.
//
// A ONE-field struct (`struct { var string text }`) does NOT reproduce —
// the multi-field (T_SIZE > 8, memcpy'd element) shape is required.
//
// Found by the differator port: `combined`'s move detection builds a
// `List<LineUnit>` (7 fields incl. a string), passes it by ref, and its
// first phase copies each unit out and normalizes `u.text` — every
// real-world-sized input crashed on the C backend while the tiny unit tests
// (single-line changes) passed. Bisected to this shape via a phase-gated
// build; see differator/nomen/FINDINGS 4.md.

describe("multi-field struct element list as a parameter: remaining gaps", () => {
	test("callee looping at() over a param List<wide struct> keeps memory sound", async () => {
		const input = `import System

func part_of = (string text, int start, int end, out string) {
	var sb = StringBuilder()
	var int i = start
	if i < 0 {
		i = 0
	}
	while i < end && i < text.length {
		sb.append_char(text.at(i))
		i += 1
	}
	return sb.to_string()
}

func normalize2 = (string text, out string) {
	if text.length > 18 {
		return part_of(text, 0, 18)
	}
	return text
}

pub struct NS {
	var side = 0
	var text = ""
	var index = 0
	var length = 0
	var line = 0
	var diff_index = 0
	var moved = false
}

func build_norm = (List<NS> units, out List<string>) {
	var List<string> norm = List<string>()
	var k = 0
	while k < units.length {
		var NS u0 = units.at(k)
		var string t0 = u0.text
		norm.push(normalize2(t0))
		k += 1
	}
	return norm
}

pub func main = () {
	var string src = ""
	var int q = 0
	while q < 300 {
		src = src + "abcdefghijklmnopqrst"
		q += 1
	}
	var List<NS> units = List<NS>()
	var int i = 0
	var int next = 0
	while i < 300 {
		next = i + 20
		var u = NS()
		u.text = part_of(src, i, next)
		u.side = i
		units.push(mov u)
		i = next
	}
	Console.write_line("units \\{units.length} norm \\{build_norm(units).length}")
}
`;
		await build_and_check_output(input, "gap_wide_struct_list_param", "units 15 norm 15\n", true);
	});
});
