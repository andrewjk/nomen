import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import trim_code from "./trim_code";

test("ziglings 004 arrays -- errors", () => {
  const input = `
import System

pub func main = () -> {
  const uint8[] some_primes = [ 1, 3, 5, 7, 11, 13, 17, 19 ]

  some_primes[0] = 2

  const first = some_primes[0]
  const fourth = some_primes[???]
  const length = some_primes.???

  Console.write("First: \\{first}, Fourth: \\{fourth}, Length: \\{length}\\n")
}
`;
  const expected = [
    test_error(input, "Assignment to const: some_primes", 7, 3),
    test_error(input, "Unknown value: ???", 10, 30),
    test_error(input, "Field not found: ???", 11, 30),
    test_error(input, "Unknown value: length", 13, 64),
  ];
  const parsed = parse_with_imports(input);
  expect(parsed.errors).toEqual(expected);
});

test("ziglings 004 arrays -- fixed", () => {
  const input = `
import System

pub func main = () -> {
  var uint8[] some_primes = [ 1, 3, 5, 7, 11, 13, 17, 19 ]

  some_primes[0] = 2

  const first = some_primes[0]
  const fourth = some_primes[3]
  const length = some_primes.length

  Console.write("First: \\{first}, Fourth: \\{fourth}, Length: \\{length}\\n")
}`;
  const parsed = parse_with_imports(input);
  expect(parsed.errors).toEqual([]);
});

test("ziglings 004 arrays -- build", async () => {
  const input = `
import System

pub func main = () -> {
  var uint8[] some_primes = [ 1, 3, 5, 7, 11, 13, 17, 19 ]

  some_primes[0] = 2

  const first = some_primes[0]
  const fourth = some_primes[3]
  const length = some_primes.length

  Console.write("First: \\{first}, Fourth: \\{fourth}, Length: \\{length}\\n")
}
`;
  const parsed = parse_with_imports(input);
  expect(parsed.errors).toEqual([]);
  const built = build(parsed.root);
  const expected = `
int main()
{
unsigned char some_primes[8] = {1, 3, 5, 7, 11, 13, 17, 19};
some_primes[0] = 2;
unsigned char first = some_primes[0];
unsigned char fourth = some_primes[3];
long length = (sizeof(some_primes) / sizeof(unsigned char));
char* _param_0 = uint8_to_string(first);
char* _param_1 = uint8_to_string(fourth);
char* _param_2 = int_to_string(length);
char* _param_3 = _string_interpolate_3("First: %s, Fourth: %s, Length: %s\\n", _param_0, _param_1, _param_2);
Console_write(_param_3);
free(_param_0);
free(_param_1);
free(_param_2);
free(_param_3);
}
`;
  expect(trim_code(built.code)).toEqual(expected.trim());

  const expected_output = "First: 2, Fourth: 7, Length: 8";
  await check_output("004", built, expected_output);
});
