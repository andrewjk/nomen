import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Regression: a string accumulator assigned inside a loop inside an
// `async { }` block. The nursery body is a hard scoped_declarations
// boundary, so the OUTER `s` was invisible to the loop's register
// promotion — and the shared force-heap scan did not descend into async
// blocks — so the literal initializer stayed a borrowed rodata pointer and
// `s` promoted as an 8-byte scalar: only its ptr half round-tripped, the
// len half never updated, and the function returned "" (leaking every
// concat result). Both backends now agree with the plain-loop shapes.
test("string accumulation in a loop inside async", async () => {
	const input = `import System

func in_async = (out string) {
	var string s = ""
	async {
		var int i = 0
		while i < 3 {
			s = s + "y"
			i += 1
		}
	}
	return s
}

pub func main = () {
	var string r = in_async()
	Console.write_line(r)
	Console.write_line("done")
}
`;
	await build_and_check_output(input, "async_loop_string_accumulate", "yyy\ndone\n", true);
}, 60000);

// A read-only outer string (never reassigned, so never force-heap) read
// several times in a loop inside async: the same mis-promotion — the fat
// pair's ptr half cached in a scalar register, the len half read from an
// unrelated register. Correct only when the loop promotion's declare-type
// lookup rejects `string` outright.
test("read-only outer string read repeatedly in a loop inside async", async () => {
	const input = `import System

func probe = (out string) {
	var string s = "abcd"
	var string t = ""
	async {
		var int i = 0
		while i < 3 {
			t = s + s + s
			i += 1
		}
	}
	return t
}

pub func main = () {
	var string r = probe()
	Console.write_line(r)
	Console.write_line("done")
}
`;
	await build_and_check_output(input, "async_loop_readonly_string", "abcdabcdabcd\ndone\n", true);
}, 60000);

test("string accumulation in a nested loop (control)", async () => {
	const input = `import System

func in_nested = (out string) {
	var string s = ""
	var int i = 0
	while i < 3 {
		var int j = 0
		while j < 2 {
			s = s + "y"
			j += 1
		}
		i += 1
	}
	return s
}

pub func main = () {
	var string r = in_nested()
	Console.write_line(r)
	Console.write_line("done")
}
`;
	await build_and_check_output(input, "nested_loop_string_accumulate", "yyyyyy\ndone\n", true);
}, 60000);
