import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";

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
  expect(result.code.trim()).toEqual(expected.trim());
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
  expect(result.code.trim()).toEqual(expected.trim());
});
