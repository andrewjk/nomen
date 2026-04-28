import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import trim_code from "./trim_code";

test.skip("ziglings 005 arrays 2 -- errors", () => {
  const input = `
import System

pub func main = () -> {
    const le = [ 1, 3 ]
    const et = [ 3, 7 ]

    const leet = ???

    const bit_pattern = [ ??? ] * 3

    Console.write("LEET: ")

    for n in leet {
        Console.write("\\{n}")
    }

    Console.write(", Bits: ")

    for n in bit_pattern {
        Console.write("\\{n}")
    }

    Console.write("\\n")
  }
`;
  const expected = [
    test_error(input, "Assignment to const: n", 2, 63),
    test_error(input, "Type mismatch in declaration: int (expected uint8)", 2, 97),
    test_error(input, "Type mismatch in declaration: int (expected uint8)", 2, 141),
  ];
  const parsed = parse_with_imports(input);
  expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 005 arrays 2 -- fixed", () => {
  const input = `
import System

pub func main = () -> {
    const le = [ 1, 3 ]
    const et = [ 3, 7 ]

    const leet = le + et

    const bit_pattern = [ 1, 0, 0, 1] * 3

    Console.write("LEET: ")

    for n in leet {
        Console.write("\\{n}")
    }

    Console.write(", Bits: ")

    for n in bit_pattern {
        Console.write("\\{n}")
    }

    Console.write("\\n")
}
`;
  const parsed = parse_with_imports(input);
  expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 005 arrays 2 -- build", async () => {
  const input = `
import System

pub func main = () -> {
  const le = [ 1, 3 ]
  const et = [ 3, 7 ]

  const leet = le + et

  const bit_pattern = [ 1, 0, 0, 1] * 3

  Console.write("LEET: ")

  for n in leet {
      Console.write("\\{n}")
  }

  Console.write(", Bits: ")

  for n in bit_pattern {
      Console.write("\\{n}")
  }

  Console.write("\\n")
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

  const expected_output = "LEET: 1 3 3 7, Bits: 1 0 0 1 1 0 0 1 1 0 0 1";
  await check_output("005", built, expected_output);
});
