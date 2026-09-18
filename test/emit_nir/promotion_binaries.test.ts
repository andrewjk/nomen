// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

test("NIR-built binaries still run correctly", async () => {
	// Behavioral belt-and-braces: the default (NIR-on) build must produce a
	// binary whose output matches — loop promotion rides the shared helper,
	// break/continue interaction included. sum_odd_to(5) = 1+3+5 = 9;
	// sum_odd_to(20) stops at the break after i=9 → 1+3+5+7 = 16.
	const { default: build_and_check_output } = await import("../build_and_check_output");
	await build_and_check_output(
		`
func sum_odd_to = (int n, out int) {
    var int total = 0
    var int i = 0
    while i < n {
        i = i + 1
        if i % 2 == 0 {
            continue
        }
        if i > 7 {
            break
        }
        total = total + i
    }
    return total
}
Console.write("\\{sum_odd_to(5)} \\{sum_odd_to(20)}")
`,
		"emit_nir_promotion",
		"9 16",
	);
});
