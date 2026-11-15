// One-off timing harness for the asm post-processing passes (COMPILER_PERF
// tranche 1 receipt). Replicates a program's assembly into a multi-function
// corpus (renaming only `main`) and times the four pipeline consumers with
// best-of-N. Measure in ONE shell context for A/B deltas — agent-spawned
// shells are not the interactive baseline (FOLLOWUP.md, "Context measurement
// hazard"); these passes are compute-bound, so same-context comparisons are
// sound. Baseline→mask-conversion receipt (630k-line corpus, regex-redux ×20,
// best-of-5): dead_cycle_moves 768.0 → 357.2 ms, lift_functions 480.3 → 417 ms
// (shared lift pass), remat/staging_elide ~unchanged (their fixpoints only
// run when candidates exist on the corpus).
import fs from "node:fs";

import { eliminate_dead_cycle_moves } from "../../src/build_aarch64/asm_cycle_dead_moves.ts";
import { rematerialize_constants } from "../../src/build_aarch64/asm_remat.ts";
import { elide_stack_staging } from "../../src/build_aarch64/asm_staging_elide.ts";
import { lift_functions } from "../../src/build_aarch64/lift_asm.ts";

const file = process.argv[2];
const reps = Number(process.argv[3] ?? "5");
const code = fs.readFileSync(file, "utf8");

// Synthesize a multi-function corpus by replicating the program text
// (functions never collide: names get a suffix per copy).
const once = code.split("\n");
const corpus_parts: string[] = [];
for (let copy = 0; copy < 20; copy++) {
	for (const line of once) {
		if (copy === 0) corpus_parts.push(line);
		else if (/^_?main:$/.test(line.trim())) corpus_parts.push(line.replace(/main/, `main_${copy}`));
		else if (/^\.globl _main$/.test(line.trim())) corpus_parts.push(`.globl _main_${copy}`);
		else corpus_parts.push(line);
	}
}
const corpus = corpus_parts.join("\n");
console.log(`corpus lines: ${corpus_parts.length}`);

const t = (name: string, fn: () => string): void => {
	// warm once
	fn();
	const times: number[] = [];
	for (let i = 0; i < reps; i++) {
		const start = performance.now();
		fn();
		times.push(performance.now() - start);
	}
	const best = Math.min(...times);
	console.log(`${name}: ${best.toFixed(1)}ms`);
};

t("lift_functions", () =>
	lift_functions(corpus)
		.result.lines.map((l) => l.text)
		.join("\n"),
);
t("remat", () => rematerialize_constants(corpus));
t("staging_elide", () => elide_stack_staging(corpus));
t("dead_cycle_moves", () => eliminate_dead_cycle_moves(corpus));
