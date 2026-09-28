import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

test("baseline string param shape (no structs)", async () => {
	await build_and_check_output(
		`
var string pre = "pre"
func use2 = (string s) {
	Console.write_line("x: " + s)
}
use2(pre)
Console.write_line("done")
`,
		"zz_probe_string",
		"x: pre\ndone\n",
	);
});

test("baseline read-only struct borrow (pre-change alias shape)", async () => {
	await build_and_check_output(
		`
struct Info { var markup = "" }
func use = (Info p) {
	Console.write_line("x: " + p.markup)
}
var Info a = Info()
a.markup = "m"
use(a)
Console.write_line("done")
`,
		"zz_probe_borrow",
		"x: m\ndone\n",
	);
});
