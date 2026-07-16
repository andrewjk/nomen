import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench } from "./helpers";

describe("bench/echo/merkletrees.echo", () => {
  test("parses without errors", () => {
    expect(parse_bench("merkletrees").errors).toEqual([]);
  });

  test("produces correct output on both backends", async () => {
    const expected = [
      "stretch tree of depth 7\t root hash: 128 check: 1",
      "64\t trees of depth 4\t root hash sum: 1024",
      "16\t trees of depth 6\t root hash sum: 1024",
      "long lived tree of depth 6\t root hash: 64 check: 1",
      "",
    ].join("\n");
    await build_and_check_bench("merkletrees", expected);
  });
});
