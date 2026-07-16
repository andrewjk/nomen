import { describe, test, expect } from "vite-plus/test";

import { parse_bench, build_and_check_bench_with_files } from "./helpers";

describe("bench/echo/knucleotide.echo", () => {
  test("parses without errors", () => {
    expect(parse_bench("knucleotide").errors).toEqual([]);
  });

  test("produces correct output on both backends", async () => {
    // The default input (25000_in) has no >THREE header, so the sequence
    // extraction yields an empty dataset and every k-mer count is zero.
    await build_and_check_bench_with_files(
      "knucleotide",
      "\n\n0\tGGT\n0\tGGTA\n0\tGGTATT\n0\tGGTATTTTAATT\n0\tGGTATTTTAATTTATAGT\n",
      { "25000_in": "25000_in" },
    );
  });
});
