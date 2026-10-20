import type FunctionNode from "./nodes/FunctionNode.ts";

/**
 * Parses the leading `#arch:` / `#platform:` / `#scope:` directives at the top
 * of a raw (inline) code block and decides whether the block should be emitted
 * for the given target architecture and platform.
 *
 * Returns the remaining code (directives stripped) and a boolean indicating
 * whether the block matches the current target. Blocks without an explicit
 * `#arch:` / `#platform:` always match.
 *
 * `is_c` is set to `true` when the block matched via `aarch64_use_c` — meaning
 * the code is C source that should be compiled and linked as a companion file,
 * not emitted inline as assembly.
 */
export interface ParsedRawBlock {
	should_emit: boolean;
	code: string;
	scope: "block" | "file";
	is_c: boolean;
}

export function parse_raw_directives(
	content: string,
	arch: string,
	platform: string,
): ParsedRawBlock {
	const lines = content.split("\n");
	let i = 0;
	let arches: string[] | null = null;
	let platforms: string[] | null = null;
	let scope: "block" | "file" = "block";

	while (i < lines.length) {
		const trimmed = lines[i].trim();
		if (trimmed.length === 0) {
			i++;
			continue;
		}
		if (trimmed.startsWith("#arch:")) {
			arches = trimmed
				.substring(6)
				.split(",")
				.map((a) => a.trim())
				.filter((a) => a.length > 0);
			i++;
			continue;
		}
		if (trimmed.startsWith("#platform:")) {
			platforms = trimmed
				.substring(10)
				.split(",")
				.map((p) => p.trim())
				.filter((p) => p.length > 0);
			i++;
			continue;
		}
		if (trimmed.startsWith("#scope:")) {
			scope = trimmed.substring(7).trim() === "file" ? "file" : "block";
			i++;
			continue;
		}
		break;
	}

	const code = lines.slice(i).join("\n").trim();

	// Determine arch match. When targeting aarch64, `aarch64_use_c` blocks
	// match but flag the code as C (not assembly).
	let arch_ok = !arches;
	let is_c = false;
	if (arches) {
		if (arches.includes(arch)) {
			arch_ok = true;
		} else if (arch === "aarch64" && arches.includes("aarch64_use_c")) {
			arch_ok = true;
			is_c = true;
		}
	}
	const platform_ok = !platforms || platforms.includes(platform);

	return {
		should_emit: arch_ok && platform_ok,
		code,
		scope,
		is_c,
	};
}

/**
 * Describes the arch coverage of a function's raw blocks for a given target.
 *
 * - `has_match`: at least one raw block matches the target arch/platform.
 * - `has_other_arch`: at least one raw block targets a different arch (e.g.
 *   `#arch: c` when building for aarch64 without `aarch64_use_c`).
 */
export interface ArchCoverage {
	has_match: boolean;
	has_other_arch: boolean;
}

/**
 * Scans a function's statements for raw blocks and determines whether any
 * match the target architecture/platform, and whether any target a different
 * architecture (used to emit the "no aarch64 block found" error).
 */
export function check_raw_arch_coverage(
	func: FunctionNode,
	arch: string,
	platform: string,
): ArchCoverage {
	let has_match = false;
	let has_other_arch = false;

	for (const stmt of func.statements) {
		if (stmt.node_type !== "raw") continue;
		const content = (stmt as unknown as { value: string }).value;

		// Parse arch/platform tags manually (without consuming the code).
		let arches: string[] | null = null;
		let platforms: string[] | null = null;
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("#arch:")) {
				arches = trimmed
					.substring(6)
					.split(",")
					.map((a) => a.trim())
					.filter((a) => a.length > 0);
			} else if (trimmed.startsWith("#platform:")) {
				platforms = trimmed
					.substring(10)
					.split(",")
					.map((p) => p.trim())
					.filter((p) => p.length > 0);
			} else if (trimmed.length > 0) {
				break;
			}
		}

		if (!arches) continue; // no arch tag — matches everything, skip

		const platform_ok = !platforms || platforms.includes(platform);
		if (!platform_ok) continue;

		let arch_matches = arches.includes(arch);
		if (arch === "aarch64" && arches.includes("aarch64_use_c")) {
			arch_matches = true;
		}

		if (arch_matches) {
			has_match = true;
		} else {
			has_other_arch = true;
		}
	}

	return { has_match, has_other_arch };
}

/**
 * A body that MIXES `#arch: aarch64_use_c` raw blocks with code the aarch64
 * backend would silently drop. The backend routes such a function WHOLE to
 * the C companion — the concatenation of its use_c blocks (check_c_fallback)
 * — so Nomen statements around them (and raw blocks that would emit inline
 * asm on aarch64) compile on the C backend but never run on aarch64: the
 * same source would mean different things per backend. A raw block targeting
 * `c` only is the other half of a parallel per-arch implementation and is
 * fine. Platform tags are ignored (arch-level is the right granularity: a
 * platform-gated use_c block still dead-ends the statements on its own
 * platform's aarch64 build).
 */
export interface UseCMixedBody {
	/** What the aarch64 backend would drop: a Nomen statement, or a raw
	 *  block that would have emitted inline assembly. */
	dropped: "statement" | "raw asm";
	/** Position of the first dropped node (the error location). */
	start: number;
}

export function find_use_c_mixed_body(func: FunctionNode): UseCMixedBody | null {
	let has_use_c = false;
	const drops: UseCMixedBody[] = [];
	for (const stmt of func.statements) {
		if (stmt.node_type !== "raw") {
			drops.push({ dropped: "statement", start: stmt.start });
			continue;
		}
		// Parse the arch tag manually (without consuming the code), mirroring
		// parse_raw_directives' precedence: an explicit `aarch64` match emits
		// as asm, `aarch64_use_c` only when `aarch64` is absent.
		let arches: string[] | null = null;
		for (const line of (stmt as unknown as { value: string }).value.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("#arch:")) {
				arches = trimmed
					.substring(6)
					.split(",")
					.map((a) => a.trim())
					.filter((a) => a.length > 0);
			} else if (trimmed.length > 0) {
				break;
			}
		}
		if (!arches) {
			// No arch tag: matches every target, emitting inline asm on
			// aarch64 — dropped when the body goes to the companion.
			drops.push({ dropped: "raw asm", start: stmt.start });
			continue;
		}
		if (arches.includes("aarch64")) {
			// Explicit inline asm on aarch64 (parse_raw_directives prefers
			// this match over `aarch64_use_c`) — also dropped when the body
			// goes to the companion.
			drops.push({ dropped: "raw asm", start: stmt.start });
			continue;
		}
		if (arches.includes("aarch64_use_c")) {
			has_use_c = true;
			continue;
		}
		// c-only: the other half of a parallel per-arch implementation.
		continue;
	}
	if (!has_use_c) return null;
	return drops[0] ?? null;
}
