import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// C auto-free mistook a `var string t = obj.field` local for an owned heap
// string: `return t` handed the caller the struct's borrowed buffer, which the
// caller then freed ("free of a non-heap pointer"). A field-read local is now
// borrow-only (never freed), and a string return of it is strdup'd. The
// tuple-destructure binding (`a = _tuple_dst._0`, a transfer) is excluded.

describe("borrowed field-read string locals", () => {
	test("kept across continue and returned", async () => {
		const input = `
struct Attr {
	var string value = ""
}

func read_kept = (ref Attr a, out string) {
	var kept = a.value
	var i = 0
	while i < 3 {
		i = i + 1
		if i == 1 {
			continue
		}
		return kept
	}
	return kept
}

func read_only = (ref Attr a, out int) {
	var t = a.value
	return t.length
}

var a = Attr()
a.value = "hello"
Console.write("kept=\\{read_kept(ref a)}\\n")
Console.write("after=\\{a.value}\\n")
Console.write("len=\\{read_only(ref a)}\\n")
Console.write("still=\\{a.value}\\n")
`;
		await build_and_check_output(
			input,
			"field_borrow_local",
			"kept=hello\nafter=hello\nlen=5\nstill=hello\n",
		);
	});
});
