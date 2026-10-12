import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// An owned (`mv out T`) call result used as the `while` POST-STATEMENT
// (`while cond; call() { }`) was discarded without being freed — one leak per
// iteration. The same call as a body statement, or a bare discarded call,
// freed correctly, so the fix routes the post-statement through the same
// statement-drop machinery as the body path (both backends).

describe("owned return discarded in a while post-statement", () => {
	test("mv out call in the update clause frees each result", async () => {
		const input = `
import System

func step = (ref int i, mv out string) {
	i += 1
	return "x".to_string()
}

pub func main = (Init init) {
	var i = 0
	while i < 3; step(ref i) {
	}
	Console.write_line("done i=\\{i}")
}
`;
		await build_and_check_output(input, "while_update_owned_return", "done i=3\n", true);
	});

	test("List.pop in the update clause frees each popped element", async () => {
		const input = `
import System

pub func main = (Init init) {
	var l = List<string>()
	l.push("a".to_string())
	l.push("b".to_string())
	l.push("c".to_string())
	while l.length > 0; l.pop() {
	}
	Console.write_line("len=\\{l.length}")
}
`;
		await build_and_check_output(input, "while_update_list_pop", "len=0\n", true);
	});
});
