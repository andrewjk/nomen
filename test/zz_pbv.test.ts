import { test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const input = `
struct Info { var markup = "" }

func fill = (Info p) {
	var string w = "written"
	p.markup = w
	Console.write_line("callee sees: " + p.markup)
}

var Info a = Info()
var string pre = "pre"
a.markup = pre
fill(a)
Console.write_line("caller sees: " + a.markup)
if a.markup == pre {
		Console.write_line("unchanged: true")
	} else {
		Console.write_line("unchanged: false")
	}
`;

test("pbv C", async () => {
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "c", audit: true });
	await check_output(
		"zz_pbv_c",
		result,
		"callee sees: written\ncaller sees: pre\nunchanged: true\n",
		{ audit: true, arch: "c" },
	);
});

test("pbv aarch64", async () => {
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	await check_output(
		"zz_pbv_a64",
		result,
		"callee sees: written\ncaller sees: pre\nunchanged: true\n",
		{ audit: true, arch: "aarch64" },
	);
});
