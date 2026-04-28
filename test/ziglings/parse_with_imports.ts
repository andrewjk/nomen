import fs from "node:fs";

import parse from "../../src/parse";

export default function parse_with_imports(source: string) {
  // TODO: Should import as a struct, so that the user calls System.Console.etc
  if (source.includes("import System")) {
    const system = fs.readFileSync("./bin/tests/System.echo", "utf8");
    //source = source.replace("import System", system);
    source += system;
  }
  return parse(source);
}
