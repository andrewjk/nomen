import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A struct with a `view string` field stored in a generic List: the
// push/at round-trip must preserve the (ptr, len) pair.
test("view-field struct in List round-trips", async () => {
	const input = `
pub struct VLine {
	var view string text
	var start = 0
}

pub class Doc {
	var text = ""
	pub func lines = (ref self, out List<VLine>) {
		var List<VLine> result = List<VLine>()
		view txt = self.text.slice(0, self.text.length)
		if txt.length >= 2 {
			view first = txt.slice(0, 2)
			var l = VLine(first)
			l.start = 0
			result.push(move l)
		}
		return result
	}
}

var d = Doc()
d.text = "hi\\n"
const ls = d.lines()
Console.write("\\{ls.length} ")
if ls.length == 1 {
	const line = ls.at(0)
	Console.write("\\{line.text.length} \\{line.start} ")
	Console.write(line.text.to_string())
}
`;
	await build_and_check_output(input, "view_struct_list_round_trip", "1 2 0 hi");
});

// Single-field view struct in a List — same pair preservation without any
// other field present.
test("single-field view struct in List round-trips", async () => {
	const input = `
pub struct VSingle {
	var view string text
}

pub class Doc {
	var text = ""
	pub func singles = (ref self, out List<VSingle>) {
		var List<VSingle> result = List<VSingle>()
		view txt = self.text.slice(0, self.text.length)
		if txt.length >= 2 {
			view first = txt.slice(0, 2)
			var l = VSingle(first)
			result.push(move l)
		}
		return result
	}
}

var d = Doc()
d.text = "hi\\n"
const ss = d.singles()
Console.write("\\{ss.length} ")
if ss.length == 1 {
	const s = ss.at(0)
	Console.write("\\{s.text.length} ")
	Console.write(s.text.to_string())
}
`;
	await build_and_check_output(input, "view_single_struct_list_round_trip", "1 2 hi");
});

// A guarded slice straight off a `self` field — no length local: bounds
// must propagate through the `self.` field path.
test("guarded slice of self field verifies", async () => {
	const input = `
pub class Doc {
	var text = ""
	pub func first_two = (ref self, out string) {
		if self.text.length >= 2 {
			view first = self.text.slice(0, 2)
			return first.to_string()
		}
		return ""
	}
}

var d = Doc()
d.text = "hi\\n"
Console.write(d.first_two())
`;
	await build_and_check_output(input, "view_guarded_self_field_slice", "hi");
});
