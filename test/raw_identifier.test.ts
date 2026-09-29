import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// `raw` was a reserved word, so it could not be an identifier. It is now a
// CONTEXTUAL keyword: a fenced ``` #arch ``` block (whose body token shares
// the `raw` token's start offset) still parses as a raw block, and is still
// rejected in user code; every other `raw` is an ordinary name.

describe("`raw` as an identifier", () => {
	test("variable, field and parameter named raw", async () => {
		const input = `
struct Box {
	var raw = ""
}

func use_raw = (int raw, out int) {
	return raw + 1
}

var raw = "x"
Console.write("var=\\{raw}\\n")
raw = "y"
Console.write("re=\\{raw}\\n")

var b = Box()
b.raw = "field"
Console.write("field=\\{b.raw}\\n")
Console.write("param=\\{use_raw(4)}\\n")

var int raw_count = 2
Console.write("count=\\{raw_count}\\n")
`;
		await build_and_check_output(
			input,
			"raw_identifier",
			"var=x\nre=y\nfield=field\nparam=5\ncount=2\n",
		);
	});
});
