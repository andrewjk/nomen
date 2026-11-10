/**
 * A tiny POSIX path implementation for the Worker bundle.
 *
 * The compiler uses `node:path` for library bookkeeping (`join`, `resolve`,
 * `relative`, `dirname`, `basename`, `sep`, `isAbsolute`). The REPL passes a
 * library rooted at a virtual `/core`, so a root-based POSIX implementation is
 * enough — and it keeps the Worker free of Node built-ins.
 */

function normalize(input: string): string {
	const absolute = input.startsWith("/");
	const out: string[] = [];
	for (const part of input.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
			else if (!absolute) out.push("..");
		} else {
			out.push(part);
		}
	}
	const joined = out.join("/");
	if (absolute) return `/${joined}`;
	return joined || ".";
}

function join(...parts: string[]): string {
	return normalize(parts.filter((part) => part !== "").join("/"));
}

function resolve(...parts: string[]): string {
	let resolved = "";
	let absolute = false;
	for (let i = parts.length - 1; i >= 0 && !absolute; i--) {
		const part = parts[i];
		if (!part) continue;
		resolved = `${part}/${resolved}`;
		absolute = part.startsWith("/");
	}
	// The virtual working directory is the filesystem root.
	if (!absolute) resolved = `/${resolved}`;
	return normalize(resolved);
}

function dirname(input: string): string {
	const norm = normalize(input);
	if (norm === "/") return "/";
	if (norm === ".") return ".";
	const index = norm.lastIndexOf("/");
	if (index === -1) return ".";
	if (index === 0) return "/";
	return norm.slice(0, index);
}

function basename(input: string, extension?: string): string {
	const norm = normalize(input);
	let base = norm.slice(norm.lastIndexOf("/") + 1);
	if (extension && base.endsWith(extension)) base = base.slice(0, -extension.length);
	return base;
}

function isAbsolute(input: string): boolean {
	return input.startsWith("/");
}

function relative(from: string, to: string): string {
	const a = resolve(from).split("/").filter(Boolean);
	const b = resolve(to).split("/").filter(Boolean);
	let common = 0;
	while (common < a.length && common < b.length && a[common] === b[common]) common++;
	const up = Array.from({ length: a.length - common }, () => "..");
	return [...up, ...b.slice(common)].join("/");
}

function extname(input: string): string {
	const base = basename(input);
	const index = base.lastIndexOf(".");
	return index <= 0 ? "" : base.slice(index);
}

export { normalize, join, resolve, dirname, basename, isAbsolute, relative, extname };
export const sep = "/";

const path = {
	sep,
	normalize,
	join,
	resolve,
	dirname,
	basename,
	isAbsolute,
	relative,
	extname,
};

export default path;
