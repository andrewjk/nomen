export default interface BuildResult {
	headers: string;
	code: string;
	/**
	 * The precompilable System translation unit's code (definitions only).
	 * Present when built via `build_split`; absent for a plain single-TU
	 * `build`. The harness compiles this once (cached by content hash) and
	 * links it with the per-program user TU, so a codegen change that only
	 * affects user emission keeps the system object warm.
	 */
	system_code?: string;
	/**
	 * The system TU's declarations/typedefs. Written to `system.h` so the
	 * user TU (which `#include`s it) can reference System types.
	 */
	system_headers?: string;
	/**
	 * C companion code for `aarch64_use_c` functions. When non-empty, the CLI
	 * writes it to a separate `.m`/`.c` file and compiles + links it alongside
	 * the main assembly output.
	 */
	companion?: string;
	/**
	 * Build-phase errors (e.g. a function has raw blocks for other arches but
	 * none matching the target architecture).
	 */
	errors?: { message: string; start: number; line: number; column: number }[];
}
