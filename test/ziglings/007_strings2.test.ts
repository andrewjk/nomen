import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
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
	const expected_output =
		"Ziggy played guitar\nJamming good with Andrew Kelley\nAnd the Spiders from Mars";
	await build_and_check_output(input, "ziglings_007", expected_output, true);
});
