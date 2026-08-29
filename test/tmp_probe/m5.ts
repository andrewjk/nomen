import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import build from "../../src/build";
import { set_loop_unrolling_enabled } from "../../src/build_aarch64/unroll";
import join from "../../src/join";
import { get_library } from "../../src/lib";
import parse from "../../src/parse";

const lib = get_library(path.resolve("core"));
const src = join("bench/nomen/mandelbrot.nm", "core");

function build_binary(dir: string, unroll: boolean): string {
	set_loop_unrolling_enabled(unroll);
	const parsed = parse(src, lib);
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
const off = build_binary("/tmp/m5_off", false);
const on = build_binary("/tmp/m5_on", true);
for (const arg of ["1000", "2000"]) {
	const o1 = execSync(`${off} ${arg}`).toString().trim();
	const o2 = execSync(`${on} ${arg}`).toString().trim();
	time(`${off} ${arg}`);
	time(`${on} ${arg}`);
	const r_off: number[] = [],
		r_on: number[] = [];
	for (let r = 0; r < 5; r++) {
		r_off.push(time(`${off} ${arg}`));
		r_on.push(time(`${on} ${arg}`));
	}
	console.log(
		`n=${arg}: no-unroll ${med(r_off).toFixed(0)}ms → unrolled ${med(r_on).toFixed(0)}ms (${(((med(r_on) - med(r_off)) / med(r_off)) * 100).toFixed(0)}%) | out ${o1 === o2 ? "identical" : "DIFFER"}`,
	);
}
// instruction census on mbrot
const lines = fs.readFileSync("/tmp/m5_on/main.s", "utf8").split("\n");
let on2 = false,
	count = 0,
	fmov = 0;
for (const l of lines) {
	if (l.startsWith("mbrot:")) on2 = true;
	else if (on2 && l.startsWith("main:")) break;
	if (
		on2 &&
		l.trim() &&
		!l.trim().startsWith(".") &&
		!l.trim().startsWith("//") &&
		!/^[A-Za-z_.$][\w.$]*:/.test(l.trim())
	) {
		count++;
		if (/^\s*fmov/.test(l)) fmov++;
	}
}
console.log(`mbrot (unrolled): ${count} instrs, ${fmov} fmovs`);
