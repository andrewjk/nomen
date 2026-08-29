import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import build from "../../src/build";
import join from "../../src/join";
import { get_library } from "../../src/lib";
import parse from "../../src/parse";
const lib = get_library(path.resolve("core"));
function build_binary(file: string, dir: string): string {
	const parsed = parse(join(file, "core"), lib);
	const result = build(parsed.root, { arch: "aarch64", optimize: true });
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(`${dir}/main.s`, result.code);
	execSync(`clang -c -x assembler ${dir}/main.s -o ${dir}/main.o`);
	execSync(`clang ${dir}/main.o -o ${dir}/bin`);
	return `${dir}/bin`;
}
function time(cmd: string): number {
	const t0 = performance.now();
	execSync(cmd);
	return performance.now() - t0;
}
function med(a: number[]): number {
	return [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
}
const benches: [string, string][] = [
	["spectral-norm", "1000"],
	["fannkuch-redux", "9"],
	["pidigits", "2000"],
	["nbody", "1000000"],
	["nsieve", "12"],
	["binarytrees", "15"],
];
for (const [name, arg] of benches) {
	const b = build_binary(`bench/nomen/${name}.nm`, `/tmp/sw3_${name}`);
	const cmd = `${b} ${arg}`.trim();
	const out = execSync(cmd).toString().trim().split("\n")[0];
	time(cmd);
	time(cmd);
	const r: number[] = [];
	for (let i = 0; i < 5; i++) r.push(time(cmd));
	console.log(`${name.padEnd(15)} ${med(r).toFixed(0).padStart(6)}ms  ${out.slice(0, 40)}`);
}
