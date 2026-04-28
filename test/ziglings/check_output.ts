import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { expect } from "vite-plus/test";

import type BuildResult from "../../src/types/BuildResult";

export default async function check_output(
  name: string,
  built: BuildResult,
  expected_output: string,
) {
  const folder = path.join(".", "test", "ziglings", "out", "ziglings_" + name);
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }

  const headerfile = path.join(folder, "main.h");
  const codefile = path.join(folder, "main.c");
  const outfile = path.join(folder, "main.out");
  fs.writeFileSync(headerfile, built.headers);
  fs.writeFileSync(codefile, built.code);

  const execPromise = util.promisify(exec);
  const { stdout, stderr } = await execPromise(`clang ${codefile} -o ${outfile} && ${outfile}`);

  if (stderr && stderr.includes("error:")) {
    expect(stderr).toBeFalsy();
  }
  expect(stdout.substring(0, expected_output.length)).toBe(expected_output);
}
