import { expect, test } from "vite-plus/test";

import ImportNode from "../../src/nodes/ImportNode.ts";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Import parse");

test("import", () => {
  const input = `
import System
`;
  const parsed = parse(input);
  const expected = new ImportNode(1, "System");
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.imports[0])).toEqual(trim_test_parse(expected));
});
