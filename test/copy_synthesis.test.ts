import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("copy() synthesis coverage", () => {
	test("mono struct copy is independent and leak-free", async () => {
		await build_and_check_output(
			`
struct Box<T> { var T value }
var Box<string> b = Box<string>("x")
var Box<string> c = b.copy()
c.value = "y"
Console.write_line(b.value)
Console.write_line(c.value)
`,
			"copy_mono_struct",
			"x\ny\n",
		);
	});

	test("struct with a required (non-defaulted) string field gets copy()", async () => {
		await build_and_check_output(
			`
struct Info { var string name }
var Info a = Info("n")
var Info b = a.copy()
b.name = "m"
Console.write_line(a.name)
Console.write_line(b.name)
`,
			"copy_required_field",
			"n\nm\n",
		);
	});
});
