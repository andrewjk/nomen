import fs from "node:fs";
import path from "node:path";

import build from "../src/build.ts";
import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";
const lib = get_library(path.resolve("core"));
const src = fs.readFileSync("bench/nomen/json-serde.nm", "utf8");
const parsed = parse(src, lib);
const names_c = JSON.parse(fs.readFileSync("test/out/system_lib/c/names.json", "utf8"));
const r = build(parsed.root, {
	arch: "c",
	audit: true,
	emit_mode: "user",
	system_struct_names: new Set(names_c),
} as any);
const dir = "test/out/c/json-serde_c";
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(`${dir}/main.m`, r.code);
if (r.headers) fs.writeFileSync(`${dir}/main.h`, r.headers);
console.log("built c");
