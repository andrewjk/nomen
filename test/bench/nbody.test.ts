import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench } from "./helpers";

describe("bench/echo/nbody.echo", () => {
  test("parses without errors", () => {
    expect(parse_bench("nbody").errors).toEqual([]);
  });

  test("produces correct output on both backends", async () => {
    await build_and_check_bench("nbody", "-0.169075\n-0.169088\n");
  });
});
