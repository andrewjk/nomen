import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import { postprocess_macos } from "./postprocess";

/**
 * Bench-matrix cross-backend identity (ASM_PLAN_7 verification
 * discipline): every bench program must produce byte-identical stdout on
 * the aarch64 and C backends. Sizes are at or below the benchmark.sh
 * small sizes (identity, not timing, is asserted here).
 */
const execFileAsync = util.promisify(execFile);
const system = get_library(path.resolve("core"));
const OUT = path.resolve("test", "out", "bench_matrix");

async function build_bench(name: string, arch: "c" | "aarch64"): Promise<string> {
	const src = fs.readFileSync(path.resolve("bench", "nomen", `${name}.nm`), "utf8");
	const parsed = parse(src, system, undefined, { allow_internal: true });
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch, optimize: true, audit: false });
	// Pre-existing validator gap (see FOLLOWUP.md): div128's raw block uses
	// GNU numeric local labels the validator rejects. The text assembles
	// and runs correctly; anything ELSE fails loudly.
	const real_errors = (result.errors ?? []).filter((e) => !/[12]f\b|— [12]:/.test(e.message));
	expect(real_errors).toEqual([]);
	const dir = path.join(OUT, `${name}_${arch}`);
	fs.mkdirSync(dir, { recursive: true });
	if (arch === "aarch64") {
		const code = postprocess_macos(result.code, false, "aarch64");
		const sfile = path.join(dir, "main.s");
		fs.writeFileSync(sfile, code);
		if (result.companion) {
			const comp = path.join(dir, "main_companion.m");
			fs.writeFileSync(comp, result.companion);
			const comp_obj = path.join(dir, "main_companion.o");
			await execFileAsync("clang", ["-c", comp, "-o", comp_obj]);
		}
		const main_obj = path.join(dir, "main.o");
		await execFileAsync("clang", ["-c", "-x", "assembler", sfile, "-o", main_obj]);
		const out = path.join(dir, "main.out");
		const link: string[] = [main_obj];
		if (result.companion) link.push(path.join(dir, "main_companion.o"));
		link.push("-o", out);
		await execFileAsync("clang", link);
		return out;
	} else {
		const ext = process.platform === "darwin" ? ".m" : ".c";
		if (result.headers) fs.writeFileSync(path.join(dir, "main.h"), result.headers);
		const codefile = path.join(dir, `main${ext}`);
		fs.writeFileSync(codefile, result.code);
		let inputs = [codefile];
		if (result.companion) {
			const comp = path.join(dir, `main_companion${ext}`);
			fs.writeFileSync(comp, result.companion);
			inputs.push(comp);
		}
		const out = path.join(dir, "main.out");
		await execFileAsync("clang", ["-O2", ...inputs, "-o", out, "-lm"]);
		return out;
	}
}

async function run_bin(bin: string, args: string[], timeout_ms: number): Promise<string> {
	const { stdout } = await execFileAsync(bin, args, {
		timeout: timeout_ms,
		maxBuffer: 256 * 1024 * 1024,
	});
	return stdout;
}

// name, argv (small/identity size)
const MATRIX: [string, string[]][] = [
	["pidigits", ["1000"]],
	["fannkuch-redux", ["10"]],
	["spectral-norm", ["500"]],
	["nbody", ["100000"]],
	["binarytrees", ["12"]],
	["merkletrees", ["12"]],
	["nsieve", ["10"]],
	["mandelbrot", ["500"]],
	["edigits", ["500"]],
	["lru", ["100", "50000"]],
	["knucleotide", [path.resolve("bench", "knucleotide_input.txt")]],
	["json-serde", [path.resolve("bench", "sample.json"), "200"]],
	["regex-redux", [path.resolve("bench", "25000_in")]],
];

for (const [name, args] of MATRIX) {
	test(`bench matrix byte-identical: ${name}`, async () => {
		const a64 = await build_bench(name, "aarch64");
		const c = await build_bench(name, "c");
		const [out_a64, out_c] = await Promise.all([
			run_bin(a64, args, 180000),
			run_bin(c, args, 180000),
		]);
		expect(out_a64).toBe(out_c);
	}, 420000);
}
