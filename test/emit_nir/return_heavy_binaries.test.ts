// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

test("NIR-native return-heavy binaries run correctly", async () => {
	// Behavioral belt-and-braces for the return/expression tranche: returns of
	// leaf/binary/call/grouped shapes across if/while/for arms, plus float (d0,
	// %f-formatted) and string (borrow-normalized) returns — all through the
	// NIR expression seam. first_hit(10)=5 (5²>20), scan_up(2)=0, scan_up(9)=40;
	// shape_test row = 0 9 14 -9; scale row = 5.0 0.75; greet = "hi world" bob.
	const { default: build_and_check_output } = await import("../build_and_check_output");
	await build_and_check_output(
		`
func helper = (int v, out int) {
    return v * 2
}
func first_hit = (int limit, out int) {
    var int i = 0
    while i < limit {
        if i * i > 20 {
            return i
        }
        i = i + 1
    }
    return 0
}
func scan_up = (int n, out int) {
    for i of 0 .. n {
        if i > 3 {
            return i * 10
        }
    }
    return 0
}
func shape_test = (int n, out int) {
    if n == 0 {
        return 0
    }
    if n == 1 {
        return (n + 2) * 3
    }
    if n == 3 {
        return helper(n) + helper(n + 1)
    }
    return 0 - n
}
func half_of = (float v, out float) {
    return v / 2.0
}
func scale = (float x, out float) {
    if x > 1.0 {
        return x * 2.5
    }
    return half_of(x) + 0.5
}
func greet = (string who, out string) {
    if who == "world" {
        return "hi " + who
    }
    return who
}
Console.write("\\{first_hit(10)} \\{scan_up(2)} \\{scan_up(9)}")
Console.write(" \\{shape_test(0)} \\{shape_test(1)} \\{shape_test(3)} \\{shape_test(9)}")
Console.write(" \\{scale(2.0)} \\{scale(0.5)}")
Console.write(" \\{greet("world")} \\{greet("bob")}")
`,
		"emit_nir_returns",
		"5 0 40 0 9 14 -9 5.000000 0.750000 hi world bob",
	);
});
