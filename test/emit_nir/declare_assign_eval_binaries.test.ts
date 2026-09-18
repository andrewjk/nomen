// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

test("NIR-native declare/assign/eval binaries run correctly", async () => {
	// Behavioral belt-and-braces for the tranche-4 paths. base: 10 → bump →
	// 11 → +=2 → 13; scaled=30, grp=12, wide=10 at declaration time;
	// ratio 0.5+0.25 → "0.750000"; greeting "hi there" + "!";
	// c.count 10+4=14; nums[0]=9. (Console.write adds no newline.)
	const { default: build_and_check_output } = await import("../build_and_check_output");
	await build_and_check_output(
		`
import System

struct Counter {
    var int count
    var string label
}

func bump = (int by, out int) {
    return by + 1
}

pub func main = () {
    var int base = 10
    var int scaled = base * 3
    var int grp = (base + 2)
    var uint64 wide = base as uint64
    var float ratio = 0.5
    var string greeting = "hi " + "there"
    var Counter c = Counter(0, "none")
    var int[3] nums = [7, 8, 5]
    c.count = base
    c.count += 4
    c.label = "set"
    base = bump(base)
    base += 2
    ratio += 0.25
    greeting = greeting + "!"
    nums.set(0, 9)
    nums.set(1, base)
    bump(base)
    Console.write("\\{base} \\{ratio} \\{greeting} \\{c.count} \\{c.label} \\{nums.at(0)} \\{nums.at(1)}")
}
`,
		"emit_nir_decl_assign_eval",
		"13 0.750000 hi there! 14 set 9 13",
		true,
	);
});
