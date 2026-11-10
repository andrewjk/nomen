import type { Library } from "../../../src/lib.ts";
import { CORE_LIBRARY } from "./core-library.generated.ts";

/** The serialized shape produced by `site/scripts/bundle-core.ts`. */
export interface SerializedLibraryEntry {
	name: string;
	path: string;
	deps: string[];
	namespace?: string;
}

export interface SerializedLibrary {
	name: string;
	dir: string;
	files: Record<string, string>;
	types: [string, SerializedLibraryEntry][];
	functions: [string, SerializedLibraryEntry][];
	namespaces: [string, string[]][];
}

let cached: Library | undefined;

/** The System library, hydrated from the embedded type map. */
export function core_library(): Library {
	if (cached) return cached;
	const source_of = (entry: SerializedLibraryEntry) => CORE_LIBRARY.files[entry.path] ?? "";
	cached = {
		name: CORE_LIBRARY.name,
		// `Library.source` is only informational; the type map carries the code.
		source: "",
		dir: CORE_LIBRARY.dir,
		types: new Map(
			CORE_LIBRARY.types.map(([name, entry]) => [name, { ...entry, source: source_of(entry) }]),
		),
		functions: new Map(
			CORE_LIBRARY.functions.map(([name, entry]) => [name, { ...entry, source: source_of(entry) }]),
		),
		namespaces: new Map(
			CORE_LIBRARY.namespaces.map(([namespace, names]) => [namespace, new Set(names)]),
		),
	};
	return cached;
}
