/**
 * Parses the leading `#arch:` / `#platform:` / `#scope:` directives at the top
 * of a raw (inline) code block and decides whether the block should be emitted
 * for the given target architecture and platform.
 *
 * Returns the remaining code (directives stripped) and a boolean indicating
 * whether the block matches the current target. Blocks without an explicit
 * `#arch:` / `#platform:` always match.
 */
export interface ParsedRawBlock {
	should_emit: boolean;
	code: string;
	scope: "block" | "file";
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
	const arch_ok = !arches || arches.includes(arch);
	const platform_ok = !platforms || platforms.includes(platform);

	return {
		should_emit: arch_ok && platform_ok,
		code,
		scope,
	};
}
