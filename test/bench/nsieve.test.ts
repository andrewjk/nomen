import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench } from "./helpers";

describe("bench/echo/nsieve.echo", () => {
  test("parses without errors", () => {
    expect(parse_bench("nsieve").errors).toEqual([]);
  });

  test("produces correct output on both backends", async () => {
    const expected = [
      "Primes up to 160000 14683",
      "Primes up to 80000 7837",
      "Primes up to 40000 4203",
      "",
    ].join("\n");
    await build_and_check_bench("nsieve", expected);
  });
});
