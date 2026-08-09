export interface Args {
	command: string | undefined;
	name?: string;
	in?: string;
	out?: string;
	config?: string;
	watch: boolean;
	filter?: string;
	arch: string;
	platform?: string;
	lib?: string;
	audit: boolean;
	audit_runtime?: string;
	check: boolean;
	// Everything after a bare `--` on the command line — forwarded verbatim to
	// the compiled program by `nomen run`. Lets a program receive its own argv
	// (`nomen run --in app/main.nm -- arg1 arg2`).
	program_args: string[];
}

// Canonical option name for each accepted long/short spelling.
const STRING_OPTIONS: Map<string, string> = new Map([
	["in", "in"],
	["i", "in"],
	["out", "out"],
	["o", "out"],
	["config", "config"],
	["c", "config"],
	["filter", "filter"],
	["f", "filter"],
	["arch", "arch"],
	["a", "arch"],
	["platform", "platform"],
	["p", "platform"],
	["lib", "lib"],
	["l", "lib"],
	["audit-runtime", "audit_runtime"],
]);

const BOOLEAN_OPTIONS: Map<string, string> = new Map([
	["watch", "watch"],
	["w", "watch"],
	["audit", "audit"],
	["check", "check"],
]);

const DEFAULTS: Partial<Args> = {
	arch: "aarch64",
	watch: false,
	audit: false,
	check: false,
};

function set(args: Args, key: string, value: string | boolean): void {
	(args as unknown as Record<string, string | boolean>)[key] = value;
}

/** Parse `argv` (excluding the node binary and script path) into an `Args` object. */
export function parse_args(argv: string[] = process.argv.slice(2)): Args {
	const args: Args = { command: undefined, ...DEFAULTS, program_args: [] } as Args;
	const positional: string[] = [];

	const next_value = (i: number, spelling: string): string => {
		if (i + 1 >= argv.length) throw new Error(`Option ${spelling} requires a value`);
		return argv[i + 1];
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		// A bare `--` ends nomen's own option parsing; everything that follows
		// is captured verbatim as the compiled program's argv (forwarded by
		// `nomen run`). This matches the conventional `--` passthrough.
		if (arg === "--") {
			args.program_args = argv.slice(i + 1);
			break;
		}

		if (arg === "-h" || arg === "--help") {
			print_help();
			process.exit(0);
		}

		// Long option: --name, --name=value, or --name value
		if (arg.startsWith("--") && arg.length > 2) {
			const eq = arg.indexOf("=");
			const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
			const inline = eq === -1 ? undefined : arg.slice(eq + 1);

			if (STRING_OPTIONS.has(name)) {
				const key = STRING_OPTIONS.get(name)!;
				set(args, key, inline !== undefined ? inline : next_value(i, `--${name}`));
				if (inline === undefined) i++;
			} else if (BOOLEAN_OPTIONS.has(name)) {
				const key = BOOLEAN_OPTIONS.get(name)!;
				set(args, key, inline === undefined ? true : inline !== "false");
			} else {
				throw new Error(`Unknown option: --${name}`);
			}
			continue;
		}

		// Short option(s): -i value, -ivalue, -i=value, or combined -wv
		if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) {
			const chars = arg.slice(1);
			for (let j = 0; j < chars.length; j++) {
				const c = chars[j];

				if (c === "h") {
					print_help();
					process.exit(0);
				}

				if (STRING_OPTIONS.has(c)) {
					const key = STRING_OPTIONS.get(c)!;
					const rest = chars.slice(j + 1);
					if (rest.length > 0) {
						set(args, key, rest.startsWith("=") ? rest.slice(1) : rest);
					} else {
						set(args, key, next_value(i, `-${c}`));
						i++;
					}
					break;
				}

				if (BOOLEAN_OPTIONS.has(c)) {
					set(args, BOOLEAN_OPTIONS.get(c)!, true);
					continue;
				}

				throw new Error(`Unknown option: -${c}`);
			}
			continue;
		}

		positional.push(arg);
	}

	args.command = positional[0];
	args.name = positional[1];
	return args;
}

export function print_help(): void {
	console.log(
		[
			"Usage:",
			"  nomen run --in [file/folder]     Parse, check, build and run a program",
			"                                    (args after a bare -- are forwarded to the program)",
			"  nomen build --in [file/folder]    Parse, check and build (no run)",
			"  nomen check --in [file/folder]    Parse and check only",
			"  nomen format [--in folder]        Reformat every .nm file",
			"  nomen docs [--in file]            Generate markdown documentation",
			"  nomen test [--in folder]          Discover and run *.test.nm files",
			"  nomen init <name>                 Scaffold a new project in ./<name>",
			"  nomen lib-path                    Print the bundled System library path",
			"",
			"Options:",
			"  --in, -i <path>         Input file or folder",
			"  --out, -o <path>        Output file",
			"  --config, -c <path>     Path to a config file",
			"  --watch, -w             Watch for file changes",
			"  --filter, -f <regex>    Only run test files whose path matches this regex",
			"  --arch, -a <arch>       Target architecture: aarch64 | c (default: aarch64)",
			"  --platform, -p <name>   Target platform: macos, ios, linux, android, windows, web",
			"  --lib, -l <path>        Path to System library directory (containing package.jsonc)",
			"  --audit                 Audit the generated program for memory issues",
			"  --audit-runtime <path>  Path to audit_runtime.c, linked in when --audit is set",
			"  --check                 For `nomen format`: report files that would change",
			"  -h, --help              Show this help",
		].join("\n"),
	);
}
