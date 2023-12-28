import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";

const test = suite("Control build");

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
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
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
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
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
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
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
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
