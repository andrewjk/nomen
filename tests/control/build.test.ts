import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Control build");

test("break", () => {
  const input = `
for x in 0..5 {
  break
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x;
for (x = 0; x < 5; x++)
{
break;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("continue", () => {
  const input = `
for x in 0..5 {
  continue
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x;
for (x = 0; x < 5; x++)
{
continue;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("panic", () => {
  const input = `
func add() -> int {
  panic "something went wrong"
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
void add()
{
printf("something went wrong\\n");
exit(EXIT_FAILURE);
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("todo", () => {
  const input = `
func add() -> int {
  todo "haven't done this yet"
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
void add()
{
printf("haven't done this yet\\n");
exit(EXIT_FAILURE);
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
