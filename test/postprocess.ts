/**
 * macOS aarch64 symbol conventions. The generated aarch64 assembly uses bare
 * function names; on Mach-O, cross-object references require the leading
 * underscore (the C ABI), and bare `L`-prefixed names are treated as local and
 * can't be globalized. So:
 *  - libc calls (`bl printf`) get `_printf`.
 *  - `main` becomes the global `_main` entry point.
 *  - For the precompiled system object, functions are exported as `_name`
 *    aliases; the user TU's references to them are rewritten to `_name` too.
 */

export function postprocess_macos(code: string, audit = false, arch: string = "c"): string {
	if (arch === "aarch64") {
		code = code.replace(/\bbl printf\b/g, "bl _printf");
		code = code.replace(/\bbl snprintf\b/g, "bl _snprintf");
		code = code.replace(/\bbl malloc\b/g, "bl _malloc");
		code = code.replace(/\bbl exit\b/g, "bl _exit");
		code = code.replace(/\bbl realloc\b/g, "bl _realloc");
		code = code.replace(/\bbl free\b/g, "bl _free");
		code = code.replace(/\bbl strdup\b/g, "bl _strdup");
		if (audit) {
			code = code.replace(/\bbl _malloc\b/g, "bl _nomen_malloc_wrap");
			code = code.replace(/\bbl _calloc\b/g, "bl _nomen_calloc_wrap");
			code = code.replace(/\bbl _realloc\b/g, "bl _nomen_realloc_wrap");
			code = code.replace(/\bbl _free\b/g, "bl _nomen_free_wrap");
			code = code.replace(/\bbl _strdup\b/g, "bl _nomen_strdup_wrap");
		}
		code = code.replace(/\bmain:\n/g, ".globl _main\n_main:\n");
	}
	return code;
}

/**
 * Postprocess the USER translation unit of an aarch64 split build. Identical
 * to postprocess_macos, then rewrites every reference to a System function
 * name to its exported `_NAME` alias. `\b`-anchoring skips already-underscored
 * references (audit wrappers, the `_string_interpolate_N` helpers which are
 * already `_`-prefixed) and local `.L…` labels, so there's no double-underscore
 * or corruption.
 *
 * Taking the ADDRESS of a System function (`var f = Console.write`) needs a
 * GOT reference, because `adr` can only reach symbols within the same object
 * and the System functions now live in the separate system.o. Rewrite those
 * to `adrp` + `ldr` through the GOT.
 */
export function postprocess_macos_for_user(
	code: string,
	audit: boolean,
	system_fn_names: string[],
): string {
	code = postprocess_macos(code, audit, "aarch64");
	for (const name of system_fn_names) {
		code = code.replace(new RegExp(`\\b${name}\\b`, "g"), `_${name}`);
		// `adr xN, _NAME` — function address of an external (system) symbol.
		// (Local `.L…` data labels and `_str_N` literals don't match: they
		// aren't in system_fn_names.)
		code = code.replace(
			new RegExp(`\\badr (x\\d+), _${name}\\b`, "g"),
			`adrp $1, _${name}@GOTPAGE\nldr $1, [$1, _${name}@GOTPAGEOFF]`,
		);
	}
	return code;
}
