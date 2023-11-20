import { suite } from "uvu";
import assert from "uvu/assert";
import tokenize from "../src/tokenize";

const test = suite("Tokenization");

test("spaced", () => {
  const input = `
word ! x = 5
`;
  const tokens = tokenize(input);
  const expected = ["word", "!", "x", "=", "5"];
  assert.equal(
    tokens.map((t) => t.value),
    expected,
  );
});

test("unspaced", () => {
  const input = `
word!x=5
`;
  const tokens = tokenize(input);
  const expected = ["word", "!", "x", "=", "5"];
  assert.equal(
    tokens.map((t) => t.value),
    expected,
  );
});

test("group symbols", () => {
  const input = `
word && x ! = 5
`;
  const tokens = tokenize(input);
  const expected = ["word", "&&", "x", "!", "=", "5"];
  assert.equal(
    tokens.map((t) => t.value),
    expected,
  );
});

test("string", () => {
  const input = `
word "I'm in a string!" 5
`;
  const tokens = tokenize(input);
  const expected = ["word", `"I'm in a string!"`, "5"];
  assert.equal(
    tokens.map((t) => t.value),
    expected,
  );
});

test("nested string", () => {
  const input = `
word "I'm in a \\"nested\\" string!" 5
`;
  const tokens = tokenize(input);
  const expected = ["word", `"I'm in a \\"nested\\" string!"`, "5"];
  assert.equal(
    tokens.map((t) => t.value),
    expected,
  );
});

test("multi line string", () => {
  const input = `
word "I'm in a
multi-line string!" 5
`;
  const tokens = tokenize(input);
  const expected = ["word", `"I'm in a\nmulti-line string!"`, "5"];
  assert.equal(
    tokens.map((t) => t.value),
    expected,
  );
});

test("string unspaced", () => {
  const input = `
word"I'm in a string!"5
`;
  const tokens = tokenize(input);
  const expected = ["word", `"I'm in a string!"`, "5"];
  assert.equal(
    tokens.map((t) => t.value),
    expected,
  );
});

test("one line comment", () => {
  const input = `
word // I'm in a comment!
`;
  const tokens = tokenize(input);
  const expected = ["word", "// I'm in a comment!"];
  assert.equal(
    tokens.map((t) => t.value),
    expected,
  );
});

test("one line comment unspaced", () => {
  const input = `
word//I'm in a comment!
`;
  const tokens = tokenize(input);
  const expected = ["word", "//I'm in a comment!"];
  assert.equal(
    tokens.map((t) => t.value),
    expected,
  );
});

test("multi line comment", () => {
  const input = `
word /* I'm in a
multi-line comment */ 5
`;
  const tokens = tokenize(input);
  const expected = ["word", "/* I'm in a\nmulti-line comment */", "5"];
  assert.equal(
    tokens.map((t) => t.value),
    expected,
  );
});

test("multi line comment unspaced", () => {
  const input = `
word/*I'm in a
multi-line comment*/5
`;
  const tokens = tokenize(input);
  const expected = ["word", "/*I'm in a\nmulti-line comment*/", "5"];
  assert.equal(
    tokens.map((t) => t.value),
    expected,
  );
});

test("nested comments", () => {
  const input = `
word /* I'm in a
/* nested */ comment */ 5
`;
  const tokens = tokenize(input);
  const expected = ["word", "/* I'm in a\n/* nested */ comment */", "5"];
  assert.equal(
    tokens.map((t) => t.value),
    expected,
  );
});

test.run();
