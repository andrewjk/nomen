import check from "./check.ts";
import type { Library } from "./lib.ts";
import RootNode from "./nodes/RootNode.ts";
import parse_statement from "./parse/parse_statement.ts";
import type ParseStatus from "./parse/ParseStatus.ts";
import tokenize from "./tokenize.ts";
import type CompileError from "./types/CompileError.ts";
import type ParseResult from "./types/ParseResult.ts";

export default function parse(source: string, library?: Library): ParseResult {
	if (library) {
		source = resolve_linked_types(source, library);
	}

	const tokens = tokenize(source);

	const root = new RootNode();

	const status: ParseStatus = {
		tokens,
		i: 0,
		stack: [root],
		// TODO: Should be the base namespace, from module.config, folder structure, file name
		namespace: "",
		errors: [],
	};

	parse_statement(status);

	// No point type checking if the syntax is busted
	if (status.errors.length) {
		return {
			ok: false,
			root,
			errors: format_errors(source, status.errors),
		};
	}

	const checked = check(root);

	return {
		ok: !checked.errors.length,
		root,
		errors: format_errors(source, checked.errors),
	};
}

function resolve_linked_types(source: string, library: Library): string {
	const tokens = tokenize(source);

	let has_system_import = false;
	for (let i = 0; i < tokens.length - 1; i++) {
		if (tokens[i].value === "import" && tokens[i + 1].value === "System") {
			has_system_import = true;
			break;
		}
	}
	if (!has_system_import) return source;

	// User-defined types shadow library types of the same name, so the library
	// version must not be pulled in (otherwise duplicate symbols at build time).
	const user_defined = new Set<string>();
	for (let i = 0; i < tokens.length; i++) {
		if (["struct", "trait", "enum", "bitset"].includes(tokens[i].value)) {
			if (i + 1 < tokens.length) {
				user_defined.add(tokens[i + 1].value);
			}
		}
	}

	const needed = new Set<string>(BASE_TYPES);
	for (const token of tokens) {
		if (user_defined.has(token.value)) continue;
		if (library.types.has(token.value) && !BASE_TYPES.includes(token.value)) {
			needed.add(token.value);
		}
	}

	const resolved = resolve_types_with_deps(needed, library);
	if (!resolved) return source;

	return source + "\n" + resolved;
}

const BASE_TYPES = [
	"Disposable",
	"Stringable",
	"int",
	"uint",
	"int8",
	"uint8",
	"float",
	"char",
	"string",
	"Array",
	"Console",
	"bool",
];

function resolve_types_with_deps(needed: Set<string>, library: Library): string {
	const resolved = new Set<string>();
	const result: string[] = [];

	function resolve(name: string) {
		if (resolved.has(name)) return;
		const entry = library.types.get(name);
		if (!entry) return;
		for (const dep of entry.deps) {
			resolve(dep);
		}
		resolved.add(name);
		result.push(entry.source);
	}

	for (const name of needed) {
		resolve(name);
	}

	return result.join("\n");
}

function format_errors(source: string, errors: CompileError[]) {
	errors = errors.sort((a, b) => a.start - b.start).filter((e) => e.start >= 0);

	// Add line and column information to errors
	let line = 1;
	let lastLineStart = 0;
	for (let i = 0, e = 0; i < source.length, e < errors.length; i++) {
		if (source[i] === "\n") {
			line += 1;
			lastLineStart = i + 1;
		}
		while (e < errors.length && errors[e].start === i) {
			errors[e].line = line;
			errors[e].column = i - lastLineStart + 1;
			e += 1;
		}
	}

	return errors;
}
