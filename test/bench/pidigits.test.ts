import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench } from "./helpers";

describe("bench/echo/pidigits.echo", () => {
  test("parses without errors", () => {
    expect(parse_bench("pidigits").errors).toEqual([]);
  });

  test("produces correct output on both backends", async () => {
    // check_output compares only a prefix; pidigits prints 2000 digits
    // then "\t:2000". Verify the well-known opening of pi.
    await build_and_check_bench(
      "pidigits",
      "31415926535897932384626433832795028841971693993751",
    );
  });
});
