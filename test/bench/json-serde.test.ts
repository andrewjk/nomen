import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench_with_files } from "./helpers";

describe("bench/echo/json-serde.echo", () => {
  test("parses without errors", () => {
    expect(parse_bench("json-serde").errors).toEqual([]);
  });

  test("produces correct output on both backends", async () => {
    await build_and_check_bench_with_files("json-serde", "691\n6910\n", {
      "sample.json": "bench/sample.json",
    });
  });
});
