import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 006 strings -- errors", () => {
	const input = `
import System

pub func main = () {
    const ziggy = "stardust"

    const d = ziggy.at(???)

    const laugh = "ha " ???

    const major = "Major"
    const tom = "Tom"
    const major_tom = major ??? tom

    Console.write("d=\\{d} \\{laugh}\\{major_tom}\\n")
}
`;
	const expected = [
		test_error(input, "Unknown value: ???", 7, 24),
		test_error(input, "Unknown value: ???", 9, 25),
		test_error(input, "Unknown value: ???", 13, 29),
	];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test("ziglings 006 strings -- fixed", () => {
	const input = `
import System

pub func main = () {
    const ziggy = "stardust"

    const d = ziggy.at(4)

    const laugh = "ha " * 3

    const major = "Major"
    const tom = "Tom"
    const major_tom = major + " " + tom

    Console.write("d=\\{d} \\{laugh}\\{major_tom}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 006 strings -- build", async () => {
	const input = `
import System

pub func main = () {
    const ziggy = "stardust"

    const d = ziggy.at(4)

    const laugh = "ha " * 3

    const major = "Major"
    const tom = "Tom"
    const major_tom = major + " " + tom

    Console.write("d=\\{d} \\{laugh}\\{major_tom}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	const expected_output = "d=d ha ha ha Major Tom";
	await check_output_aarch64("006", built, expected_output);
});
