/**
 * Derive a default target platform from the host when none is supplied.
 *
 * Shared by the build (src/build.ts) and the check (src/check.ts) phases —
 * both must agree on the target so compile-time `#if META.platform`
 * conditions fold to the same world the raw-block `#platform:` directives
 * match at build time. Lives in its own module so the checker doesn't have
 * to import the backend graph (the same reason is_system_definition.ts is
 * a shared util rather than a build.ts export).
 */
export default function default_platform(): string {
	switch (process.platform) {
		case "darwin":
			return "macos";
		case "linux":
			return "linux";
		case "win32":
			return "windows";
		default:
			return process.platform;
	}
}
