import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A switch case condition's hoisted call-argument temps (`const _param_N =
// lt + 1`) leaked into the case BRANCH: the condition's parent is the switch
// (not a block), so promote_allocations left them pending and the next
// checked statement — the branch's first one — carried them. The generated
// code read `_param_N` in the `if` before its declaration inside the branch
// body (C: "use of undeclared identifier"; aarch64: undefined `_param_N`
// symbol in Span_init). They are now anchored on the condition node, and
// build_switch_node's statement splitter hoists them ahead of the `if`.

describe("switch case condition allocations", () => {
	test("case condition is a method call with a computed argument", async () => {
		const input = `
import System

struct Span {
	var text_end = 0
	var next = 0
}

func probe = (string content, int from, out Span) {
	var done = false
	while !done {
		var lt = content.index_of_from("<", from)
		switch {
			case content.char_code_at_or(lt + 1, -1) != 47 {
				done = true
			}
			else {
				done = true
			}
		}
	}
	var result = Span()
	result.text_end = from
	return result
}

pub func main = (Init init) {
	var span = probe("a<b", 0)
	Console.write("text_end=\\{span.text_end}\\n")
}
`;
		await build_and_check_output(input, "switch_condition_alloc", "text_end=0\n", true);
	});

	test("case condition temp in a plain (void) switch", async () => {
		const input = `
import System

func classify = (string tag, out int) {
	var kind = 0
	switch {
		case tag.char_code_at_or(0, -1) == 112 {
			kind = 1
		}
		else {
			kind = 2
		}
	}
	return kind
}

pub func main = (Init init) {
	Console.write("p=\\{classify("p")} x=\\{classify("x")}\\n")
}
`;
		await build_and_check_output(input, "switch_condition_alloc_void", "p=1 x=2\n", true);
	});
});
