import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// `init_expr_field_default` (aarch64 ctor field defaults) read the STALE
// `last_result_is_heap` flag to decide whether a class's string field default
// needed a strdup — the flag was whatever the PREVIOUS field's emission (or
// the previous function's last statement) had left behind. A heap-setting
// default followed by a non-flag-setting default (a grouped literal) skipped
// the dup, stored a rodata pointer in the always-heap class field, and the
// `<Class>_destroy` free tripped the audit (invalid free of static storage).

describe("ctor field defaults establish a fresh ownership signal", () => {
	test("heap-setting default followed by a grouped literal (audit clean)", async () => {
		const input = `
import System

func generate = (move out string) {
	return "heap-one"
}

class C {
	var string a = generate()
	var string b = ("literal")
}

pub func main = () {
	var c = C()
	Console.write_line(c.a)
	Console.write_line(c.b)
}
`;
		await build_and_check_output(input, "ctor_default_stale_flag", "heap-one\nliteral\n", true);
	});
});
