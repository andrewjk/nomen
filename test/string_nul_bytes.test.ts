import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Strings are byte arrays: a 0x00 byte is ordinary data and must survive
// every owned copy (copies are length-based, never strdup), on aarch64, C
// and JS alike.

const HELPERS = `
func show = (view string s) {
	var codes = ""
	for i of 0 .. s.length {
		codes = codes + "\\{s.char_code_at_or(i, -1)} "
	}
	Console.write_line(codes)
}

mv struct Box {
	mv string s
}

mv enum Tagged {
	case some(string value)
	case empty
}

error ParseError {
	case bad
}

func make = (mv out string) {
	return "a\\x00b"
}

func parse = (view string s, mv out string ! ParseError) {
	return s.to_string()
}
`;

async function run(name: string, body: string, expected: string): Promise<void> {
	const input = `
import System
${HELPERS}
pub func main = () {
${body}
}
`;
	await build_and_check_output(input, name, expected, true, { js: true });
}

describe("strings holding NUL bytes", () => {
	test("copies, returns, fields and concatenation keep every byte", async () => {
		await run(
			"string_nul_copies",
			`
const a = "a\\x00b"
show(a)
const b = a.copy()
show(b)
show(make())
const box = Box(a.to_string())
show(box.s)
show(a + "c")
const tagged = Tagged.some(a.to_string())
match tagged {
	case .some(v) -> show(v)
	case .empty -> Console.write_line("empty")
}
match parse(a) {
	case .ok(v) -> show(v)
	case .fail(e) -> Console.write_line("fail")
}
`,
			"97 0 98 \n".repeat(4) + "97 0 98 99 \n" + "97 0 98 \n".repeat(2),
		);
	});

	test("containers and channels keep every byte", async () => {
		await run(
			"string_nul_containers",
			`
const a = "a\\x00b"
var list = ["x", "y"]
list.set(1, a.to_string())
for x of list {
	show(x)
}
var Array<string> filled = Array.with(a.to_string(), 2)
for x of filled {
	show(x)
}
var ch = Channel()
ch.send_string(a)
show(ch.receive_string())
`,
			"120 \n" + "97 0 98 \n".repeat(4),
		);
	});
});
