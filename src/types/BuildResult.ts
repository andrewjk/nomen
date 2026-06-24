export default interface BuildResult {
	headers: string;
	code: string;
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
