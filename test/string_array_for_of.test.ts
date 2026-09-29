import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Fixed-array (`string[]`) params: `for w of words` on aarch64 loaded only the
// element's ptr half — the loop index leaked into the len half, so an owned
// string array yielded only one element's bytes (and the 8-byte item slot
// overlapped the index slot). Fat-string elements now pair-load into a
// 16-byte slot.

describe("string[] element iteration", () => {
	test("for-of over a string[] parameter", async () => {
		const input = `
import System

func join_words = (string[] words, out string) {
	var acc = ""
	for w of words {
		acc = acc + w
	}
	return acc
}

pub func main = (Init init) {
	var string[3] items = ["a", "b", "c"]
	Console.write("joined=\\{join_words(items)}\\n")
	Console.write("literal=\\{join_words(["x", "y"])}\\n")
}
`;
		await build_and_check_output(
			input,
			"string_array_param_iter",
			"joined=abc\nliteral=xy\n",
			true,
		);
	});

	test("collect string[] elements into a List", async () => {
		const input = `
import System

func collect = (string[] protocols, out List<string>) {
	var list = List<string>()
	for p of protocols {
		list.push(p)
	}
	return list
}

pub func main = (Init init) {
	var string[3] ps = ["http", "https", "irc"]
	var res = collect(ps)
	Console.write("n=\\{res.length}\\n")
	for i of 0 .. res.length {
		Console.write("item=\\{res.at(i)}\\n")
	}
}
`;
		await build_and_check_output(
			input,
			"string_array_param_collect",
			"n=3\nitem=http\nitem=https\nitem=irc\n",
			true,
		);
	});
});
