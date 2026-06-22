import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 004 arrays -- errors", () => {
	const input = `
import System

pub func main = () {
  const some_primes = Array( 1, 3, 5, 7, 11, 13, 17, 19 )

  some_primes.set(0, 2)

  const first = some_primes.at(0)
  const fourth = some_primes.at(???)
  const length = some_primes.???

  Console.write("First: \\{first}, Fourth: \\{fourth}, Length: \\{length}\\n")
}
`;
	const expected = [
		test_error(input, "Update to const: some_primes", 7, 15),
		test_error(input, "Unknown value: ???", 10, 33),
		test_error(input, "Field not found: ???", 11, 30),
		test_error(input, "Unknown value: length", 13, 64),
	];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test("ziglings 004 arrays -- fixed", () => {
	const input = `
import System

pub func main = () {
  var some_primes = Array( 1, 3, 5, 7, 11, 13, 17, 19 )

  some_primes.set(0, 2)

  const first = some_primes.at(0)
  const fourth = some_primes.at(3)
  const length = some_primes.length

  Console.write("First: \\{first}, Fourth: \\{fourth}, Length: \\{length}\\n")
}`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 004 arrays -- build", async () => {
	const input = `
import System

pub func main = () {
  var some_primes = Array( 1, 3, 5, 7, 11, 13, 17, 19 )

  some_primes.set(0, 2)

  const first = some_primes.at(0)
  const fourth = some_primes.at(3)
  const length = some_primes.length

  Console.write("First: \\{first}, Fourth: \\{fourth}, Length: \\{length}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	const expected_output = "First: 2, Fourth: 7, Length: 8";
	await check_output_aarch64("004", built, expected_output);
});
