import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// 060: Zig float types and arithmetic.
// The broken code uses f16 which overflows for 4,480,000 * 0.453592 ≈ 2M kg.
// The fix uses a larger float type. Also 4480e6 (4.48 billion) should be 4480e3 (4.48 million).
//
// Note: Nomen does not have f16 (half-precision float). All float types in Nomen
// are stored as .double (f64) in the aarch64 backend, so the f16 overflow issue
// from the Zig exercise doesn't apply. The exercise still teaches float arithmetic.
//
// Zig output: "Shuttle liftoff weight: 2032092kg\n"
// (0.453592 * 4480000 = 2032092.16, printed as whole number)

test("ziglings 060 floats -- errors", () => {
	const input = `
import System

pub func main = () {
    var float shuttle_weight = 0.453592 * 4480e6
    Console.write("Shuttle liftoff weight: \\{shuttle_weight}kg\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	// No compile error, but the value is wrong: 4480e6 = 4,480,000,000
	// Should be 4,480,000 (4480e3 or just 4480000)
});

test("ziglings 060 floats -- fixed", () => {
	const input = `
import System

pub func main = () {
    var float shuttle_weight = 0.453592 * 4480000.0
    Console.write("Shuttle liftoff weight: \\{shuttle_weight}kg\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 060 floats -- build", async () => {
	const input = `
import System

pub func main = () {
    var float shuttle_weight = 0.453592 * 4480000.0
    Console.write("Shuttle liftoff weight: \\{shuttle_weight}kg\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("060", built, "Shuttle liftoff weight: 2032092.160000kg\n");
});
