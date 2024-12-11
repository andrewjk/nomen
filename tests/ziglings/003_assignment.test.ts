import { expect, test } from "vitest";
import build from "../../src/build";
import test_error from "../test_error";
import parse_with_imports from "./parse_with_imports";
import trim_code from "./trim_code";

test("ziglings 003 assignment -- errors", () => {
  const input = `
import System

pub func main() {
    const n: uint8 = 50
    n = n + 5

    const pi: uint8 = 314159

    const negative_eleven: uint8 = -11

    Console.write("\\{n} \\{pi} \\{negative_eleven}\\n")
}
`;
  const expected = [
    test_error(input, "Assignment to const: n", 6, 5),
    test_error(input, "Type mismatch in declaration: int (expected uint8)", 8, 23),
    test_error(input, "Type mismatch in declaration: int (expected uint8)", 10, 36),
  ];
  const parsed = parse_with_imports(input);
  expect(parsed.errors).toEqual(expected);
});

test("ziglings 003 assignment -- parse", () => {
  const input = `
import System

pub func main() {
    var n: uint8 = 50
    n = n + 5

    const pi: float = 3.14159

    const negative_eleven: int8 = -11

    Console.write("\\{n} \\{pi} \\{negative_eleven}\\n")
}
`;
  const parsed = parse_with_imports(input);
  expect(parsed.errors).toEqual([]);
});

test("ziglings 003 assignment -- build", () => {
  const input = `
import System

pub func main() {
    var n: uint8 = 50
    n = n + 5

    const pi: float = 3.14159

    const negative_eleven: int8 = -11

    Console.write("\\{n} \\{pi} \\{negative_eleven}\\n")
}
`;
  const parsed = parse_with_imports(input);
  expect(parsed.errors).toEqual([]);
  const built = build(parsed.root);
  const expected = `
int main()
{
unsigned char n = 50;
n = n + 5;
float pi = 3.14159;
9;
char negative_eleven = -11;
char* _param_0 = uint8_to_string(&n);
char* _param_1 = float_to_string(&pi);
char* _param_2 = int8_to_string(&negative_eleven);
char* _param_3 = _string_interpolate_3("%s %s %s\\n", _param_0, _param_1, _param_2);
Console_write(_param_3);
free(_param_0);
free(_param_1);
free(_param_2);
free(_param_3);
}
`;
  expect(trim_code(built.code)).toEqual(expected.trim());
});
