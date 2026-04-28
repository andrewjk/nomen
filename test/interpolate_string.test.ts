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
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .quad 5
_param_0: .space 8
adr x0, x
bl int_to_string
adr x1, _param_0
str x0, [x1]
_param_1: .space 8
ldr x2, =5
adr x0, x
ldr x0, [x0]
mov x1, x0
add x0, x1, x2
bl int_to_string
adr x1, _param_1
str x0, [x1]
z: .space 8
adr x0, _param_1
ldr x0, [x0]
mov x2, x0
adr x0, _param_0
ldr x0, [x0]
mov x1, x0
adr x0, _str_6
bl _string_interpolate_2
adr x1, z
str x0, [x1]

_str_0: .asciz "from_c"
_str_1: .asciz "from_c"
_str_2: .asciz "from_c"
_str_3: .asciz "from_c"
_str_4: .asciz "from_c"
_str_5: .asciz "from_c"
_str_6: .asciz "%s is less than %s!"
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code.substring(result.code.indexOf("x: .quad 5")))).toEqual(
      trim_test_build(expected),
    );
  });
});
