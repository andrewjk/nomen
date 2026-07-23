import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

test("ziglings 016 for 2 -- errors", () => {
	const input = `
import System

pub func main = () {
    const bits = Array( 1, 0, 1, 1 )
    var int value = 0

    var int i = 0
    for bit of bits; ??? {
        const int exp = i //as uint32
        const place_value = Math.power(2, exp)
        value += place_value * bit
    }

    Console.write("The value of bits '1101': \\{value}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 016 for 2 -- fixed", () => {
	const input = `
import System

pub func main = () {
    const bits = Array( 1, 0, 1, 1 )
    var int value = 0

    var int i = 0
    for bit of bits; i += 1 {
        const int exp = i //as uint32
        const place_value = Math.power(2, exp)
        value += place_value * bit
    }

    Console.write("The value of bits '1101': \\{value}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 016 for 2 -- build", async () => {
	const input = `
import System

pub func main = () {
    const bits = Array( 1, 0, 1, 1 )
    var int value = 0

    var int i = 0
    for bit of bits; i += 1 {
        const int exp = i //as uint32
        const place_value = Math.power(2, exp)
        value += place_value * bit
    }

    Console.write("The value of bits '1101': \\{value}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);

	const expected_output = "The value of bits '1101': 13.";
	await build_and_check_output(input, "ziglings_016", expected_output, true);
});
