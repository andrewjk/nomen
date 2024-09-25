import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("While loop build");

test("while", () => {
  const input = `
var x = 0
while x < 5 {
  x = x + 1
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[1]);
  const expected = `
while (x < 5) {
x = x + 1;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("while true", () => {
  const input = `
while true {
  // ...
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
while (true) {
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
