import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// `while true` + `break`/`continue` with locals in a function returning a
// non-nullable struct corrupted results on aarch64: the loop promotion
// bracket-shared body-declared locals (t/matched) onto registers holding
// loop-carried values (search) — the plan's pairwise interference adjacency
// carries no edge for a header-only read (search is read once per iteration
// at the top, so its live range never textually overlaps an in-loop
// candidate), and the bracket's entry load then ran the scan from a garbage
// index (the returned fields kept their pre-loop sentinel values). The plan
// now publishes its loop-carried registers and the promotion refuses to
// claim or bracket-share them; candidates/occupants unknown to the plan
// never share at all.

describe("while true + break in a return-slot function", () => {
	test("raw-text scan shape (PORT.md repro E2)", async () => {
		const input = `
import System

struct Span {
	var text_end = 0
	var next = 0
}

func find_raw_text_end = (string content, int from, string tag, out Span) {
	var int search = from
	var text_end = content.length
	var resume = content.length
	while true {
		var lt = content.index_of_from("<", search)
		if lt == -1 || lt + 1 >= content.length {
			break
		}
		if content.char_code_at_or(lt + 1, -1) != 47 {
			search = lt + 1
			continue
		}
		var matched = true
		var t = 0
		while t < tag.length; t += 1 {
			var tc = content.char_code_at_or(lt + 2 + t, -1)
			if (tc | 32) != tag.char_code_at_or(t, -1) {
				matched = false
				break
			}
		}
		if !matched {
			search = lt + 1
			continue
		}
		var after = content.char_code_at_or(lt + 2 + tag.length, -1)
		if after == 62 || after == 47 || (after == 32 || after == 9 || after == 10 || after == 13 || after == 12) {
			text_end = lt
			resume = content.length
			var gt = content.index_of_from(">", lt)
			if gt != -1 {
				resume = gt + 1
			}
			break
		}
		search = lt + 1
	}
	var result = Span()
	result.text_end = text_end
	result.next = resume
	return result
}

pub func main = (Init init) {
	var content = "<p>a</p><script>alert(1)</script><p>b</p>"
	var span = find_raw_text_end(content, 16, "script")
	Console.write("text_end=\\{span.text_end} next=\\{span.next}\\n")
}
`;
		await build_and_check_output(
			input,
			"while_true_break_return_slot",
			"text_end=24 next=33\n",
			true,
		);
	});

	test("inner-loop locals shared onto a loop-carried register stay correct", async () => {
		const input = `
import System

struct Span {
	var text_end = 0
	var next = 0
}

func probe = (string content, int from, out Span) {
	var search = from
	var text_end = content.length
	var resume = content.length
	while true {
		var lt = content.index_of_from("<", search)
		if lt == -1 {
			break
		}
		var matched = true
		var t = 0
		while t < 2; t += 1 {
			if content.char_code_at_or(lt + 1 + t, -1) == 0 {
				matched = false
			}
		}
		if !matched {
			search = lt + 1
			continue
		}
		text_end = lt
		resume = lt + 1
		break
	}
	var result = Span()
	result.text_end = text_end
	result.next = resume
	return result
}

pub func main = (Init init) {
	var span = probe("ab<cd<ef", 0)
	Console.write("text_end=\\{span.text_end} next=\\{span.next}\\n")
}
`;
		await build_and_check_output(
			input,
			"while_true_break_inner_locals",
			"text_end=2 next=3\n",
			true,
		);
	});
});
