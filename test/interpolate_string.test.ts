import { expect, describe, test } from "vitest";
import build from "../src/build";
import trim_test_build from "./trim_test_build";
import parse_with_imports from "../tests/ziglings/parse_with_imports";

// BUILD
describe("interpolate string build", () => {
  test("interpolate string", () => {
    const input = `
import System

const x = 5
const z = "\\{x} is less than \\{x + 5}!"
`;
    const parsed = parse_with_imports(input);
    const result = build(parsed.root);
    const expected = `
long x = 5;
char* _param_0 = int_to_string(x);
char* _param_1 = int_to_string(x + 5);
char* z = _string_interpolate_2("%s is less than %s!", _param_0, _param_1);
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code.substring(result.code.indexOf("long x = 5;")))).toEqual(
      trim_test_build(expected),
    );
  });
});
