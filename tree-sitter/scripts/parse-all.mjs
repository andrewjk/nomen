#!/usr/bin/env node
/**
 * Parses every Nomen source in the repository with the tree-sitter grammar
 * and reports any ERROR / MISSING nodes:
 *
 *   - every `.nm` file under core/, demos/ and bench/
 *   - every ```nomen (or unlabelled) fenced code block in README.md and
 *     SPEC.md
 *
 * Usage: node scripts/parse-all.mjs [--verbose]
 *
 * Exits non-zero when any input has an ERROR or MISSING node that is not
 * listed in KNOWN_GAPS below.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const grammar_dir = path.resolve(here, "..");
const repo_root = path.resolve(grammar_dir, "..");
const cli = path.join(grammar_dir, "node_modules", ".bin", "tree-sitter");
const verbose = process.argv.includes("--verbose");

/**
 * Inputs that are known not to parse, with the reason. Keys are the
 * reported input names (a repo-relative path, or `FILE.md:LINE` for a code
 * block, where LINE is the fence's opening line).
 */
const KNOWN_GAPS = {};

/** @returns {string[]} */
function find_nm(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...find_nm(full));
		else if (entry.name.endsWith(".nm")) out.push(full);
	}
	return out;
}

/** Extracts ```nomen and unlabelled fences: [{ line, code }] */
function extract_blocks(markdown) {
	const blocks = [];
	const lines = markdown.split("\n");
	let open = -1;
	let buf = [];
	let take = false;
	for (let i = 0; i < lines.length; i++) {
		const m = /^(\s*)```(.*)$/.exec(lines[i]);
		if (!m) {
			if (open !== -1) buf.push(lines[i]);
			continue;
		}
		if (open === -1) {
			open = i + 1;
			buf = [];
			const lang = m[2].trim();
			take = lang === "" || lang === "nomen" || lang === "nm";
		} else {
			if (take) blocks.push({ line: open, code: buf.join("\n") + "\n" });
			open = -1;
		}
	}
	return blocks;
}

const inputs = []; // { name, file, line_offset }
for (const dir of ["core", "demos", "bench"]) {
	for (const file of find_nm(path.join(repo_root, dir)).sort()) {
		inputs.push({ name: path.relative(repo_root, file), file, line_offset: 0 });
	}
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-ts-"));
for (const md of ["README.md", "SPEC.md"]) {
	const text = fs.readFileSync(path.join(repo_root, md), "utf8");
	for (const block of extract_blocks(text)) {
		const file = path.join(tmp, `${md.replace(".md", "")}-${block.line}.nm`);
		fs.writeFileSync(file, block.code);
		inputs.push({ name: `${md}:${block.line}`, file, line_offset: block.line });
	}
}

function run(args) {
	try {
		return execFileSync(cli, args, {
			cwd: grammar_dir,
			encoding: "utf8",
			maxBuffer: 1 << 30,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		// `tree-sitter parse` exits 1 when any file has errors.
		return error.stdout ?? "";
	}
}

const paths_file = path.join(tmp, "paths.txt");
fs.writeFileSync(paths_file, inputs.map((i) => i.file).join("\n"));
// The summary JSON follows one plain-text line per failing file.
const summary_text = run(["parse", "--paths", paths_file, "--quiet", "--json-summary"]);
const summary = JSON.parse(summary_text.slice(summary_text.search(/^\{/m)));
const failed = new Set(
	summary.parse_summaries
		.filter((s) => !s.successful)
		.map((s) => path.resolve(grammar_dir, s.file)),
);

let unexpected = 0;
let known = 0;
for (const input of inputs) {
	if (!failed.has(input.file)) continue;
	const tree = run(["parse", input.file]);
	const problems = new Set();
	for (const m of tree.matchAll(/\((ERROR|MISSING)([^[]*)\[(\d+), (\d+)\] - \[(\d+), (\d+)\]/g)) {
		const row = Number(m[3]) + input.line_offset + 1;
		problems.add(`${m[1]}${m[2].trimEnd() ? " " + m[2].trim() : ""} at ${row}:${Number(m[4]) + 1}`);
	}
	const gap = KNOWN_GAPS[input.name];
	if (gap) {
		known++;
		if (verbose) console.log(`known  ${input.name}: ${gap}`);
		continue;
	}
	unexpected++;
	console.log(`${input.name}`);
	const list = [...problems];
	for (const p of list.slice(0, verbose ? list.length : 5)) console.log(`    ${p}`);
	if (!verbose && list.length > 5) console.log(`    … ${list.length - 5} more`);
}

// Silent misparses: a statement that is just a value (`x`, `a + b`, `mv x`)
// is legal grammar but never real Nomen — it usually means a declaration or
// a multi-line expression was split in the wrong place. Reported as
// warnings.
const suspicious_query = path.join(tmp, "suspicious.scm");
fs.writeFileSync(
	suspicious_query,
	`(expression_statement [(identifier) (member_expression) (number) (string) (binary_expression)
	  (unary_expression) (cast_expression) (generic_name) (array_literal) (struct_literal)
	  (parenthesized_expression) (enum_shorthand) (hash_identifier) (lambda_expression)
	  (index_expression) (range_expression) (qualified_identifier) (boolean) (null) (self)
	  (char)] @statement)`,
);
const by_file = new Map(inputs.map((i) => [i.file, i]));
let current;
let suspicious = 0;
for (const line of run(["query", "--paths", paths_file, suspicious_query]).split("\n")) {
	const file = by_file.get(path.resolve(grammar_dir, line.trim()));
	if (file) {
		current = file;
		continue;
	}
	const m = /start: \((\d+), (\d+)\).*text: `(.*)/.exec(line);
	if (!m || !current || KNOWN_GAPS[current.name]) continue;
	suspicious++;
	const row = Number(m[1]) + current.line_offset + 1;
	console.log(`warning: ${current.name} at ${row}:${Number(m[2]) + 1}: value statement \`${m[3]}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(
	`\n${inputs.length} inputs parsed: ${inputs.length - unexpected - known} clean, ` +
		`${known} known gaps, ${unexpected} with unexpected errors, ${suspicious} warnings`,
);
process.exit(unexpected === 0 ? 0 : 1);
