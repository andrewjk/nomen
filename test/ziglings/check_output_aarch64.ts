import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { expect } from "vitest";
import type BuildResult from "../../src/types/BuildResult";

function postprocess_macos(code: string): string {
  // macOS prefixes C library symbols with _
  code = code.replace(/\bbl printf\b/g, "bl _printf");
  code = code.replace(/\bbl snprintf\b/g, "bl _snprintf");
  code = code.replace(/\bbl malloc\b/g, "bl _malloc");
  // macOS entry point must be _main
  code = code.replace(/\bmain:\n/g, ".globl _main\n_main:\n");
  return code;
}

export default async function check_output_aarch64(
  name: string,
  built: BuildResult,
  expected_output: string,
) {
  const folder = path.join(".", "test", "ziglings", "out", "ziglings_aarch64_" + name);
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }

  const codefile = path.join(folder, "main.s");
  const outfile = path.join(folder, "main.out");

  let code = built.code;
  code = postprocess_macos(code);

  fs.writeFileSync(codefile, code);

  const execPromise = util.promisify(exec);
  const { stdout, stderr } = await execPromise(
    `clang -x assembler ${codefile} -o ${outfile} && ${outfile}`,
  );

  if (stderr && stderr.includes("error:")) {
    expect(stderr).toBeFalsy();
  }
  expect(stdout.substring(0, expected_output.length)).toBe(expected_output);
}
