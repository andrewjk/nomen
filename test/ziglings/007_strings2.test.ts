import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 007 strings 2 -- errors", () => {
	const input = `
import System

pub func main = () {
    const lyrics =
        Ziggy played guitar
        Jamming good with Andrew Kelley
        And the Spiders from Mars

    Console.write("\\{lyrics}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 007 strings 2 -- fixed", () => {
	const input = `
import System

pub func main = () {
    const lyrics =
        "Ziggy played guitar
        "Jamming good with Andrew Kelley
        "And the Spiders from Mars

    Console.write("\\{lyrics}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 007 strings 2 -- build", async () => {
	const input = `
import System

pub func main = () {
    const lyrics =
        "Ziggy played guitar
        "Jamming good with Andrew Kelley
        "And the Spiders from Mars

    Console.write("\\{lyrics}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	const expected_output =
		"Ziggy played guitar\nJamming good with Andrew Kelley\nAnd the Spiders from Mars";
	await check_output_aarch64("007", built, expected_output);
});
