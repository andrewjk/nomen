import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 005 arrays 2 -- errors", () => {
	const input = `
import System

pub func main = () {
    const le = [ 1, 3 ]
    const et = [ 3, 7 ]

    const leet = ???

    const bit_pattern = [ ??? ] * 3

    Console.write("LEET: ")

    for n of leet {
        Console.write("\\{n}")
    }

    Console.write(", Bits: ")

    for n of bit_pattern {
        Console.write("\\{n}")
    }

    Console.write("\\n")
}
`;
	const expected = [
		test_error(input, "Unknown value: ???", 8, 18),
		test_error(input, "Unknown value: ???", 10, 27),
		test_error(input, "Unknown value: leet", 14, 14),
		test_error(input, "Unknown value: n", 15, 26),
		test_error(input, "Unknown value: bit_pattern", 20, 14),
		test_error(input, "Unknown value: n", 21, 26),
	];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test("ziglings 005 arrays 2 -- fixed", () => {
	const input = `
import System

pub func main = () {
    const le = [ 1, 3 ]
    const et = [ 3, 7 ]

    const leet = le + et

    const bit_pattern = [ 1, 0, 0, 1] * 3

    Console.write("LEET: ")

    for n of leet {
        Console.write("\\{n}")
    }

    Console.write(", Bits: ")

    for n of bit_pattern {
        Console.write("\\{n}")
    }

    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 005 arrays 2 -- build", async () => {
	const input = `
import System

pub func main = () {
  const le = [ 1, 3 ]
  const et = [ 3, 7 ]

  const leet = le + et

  const bit_pattern = [ 1, 0, 0, 1] * 3

  Console.write("LEET: ")

  for n of leet {
      Console.write("\\{n}")
  }

  Console.write(", Bits: ")

  for n of bit_pattern {
      Console.write("\\{n}")
  }

  Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	const expected_output = "LEET: 1337, Bits: 100110011001";
	await check_output_aarch64("005", built, expected_output);
});
