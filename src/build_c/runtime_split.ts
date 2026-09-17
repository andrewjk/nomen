import { FIBER_HEADER, POOL_HEADER } from "./build_spawn_node.ts";

/**
 * The C system-lib TU split shares ONE copy of the concurrency runtime:
 * the `system` build defines it with external linkage (one copy per
 * process — pool queues, fiber scheduler TLS, netpoller slots), and the
 * `user` build only declares it. The canonical definition text is the
 * static POOL_HEADER + FIBER_HEADER blob; these two transforms derive the
 * split-build forms from it so the three variants cannot drift apart.
 */

/**
 * Turn the static definition blob into the system TU's global definitions:
 * file-scope `static` is stripped, and the type shapes main.h already
 * declares (struct/enum/typedef, plus the file-scope #includes/#defines)
 * are dropped. Preprocessor lines INSIDE function bodies are kept — the
 * netpoller's `#if __APPLE__` / `#else` platform branches are load-bearing
 * — and brace matching counts only the active branch so the per-branch
 * imbalance never mis-tracks a body's end. Platform-split globals
 * (`__nomen_io_kq` / `__nomen_io_epfd`) both become plain definitions — an
 * unused extra int on the other platform.
 */
export function globalize_runtime(text: string): string {
	const out: string[] = [];
	let body_depth = 0; // > 0: inside a function body (kept verbatim)
	let drop_depth = 0; // inside a struct/enum body being dropped
	const preproc: boolean[] = []; // per `#if` nest level: is this branch counted?
	const active = (): boolean => preproc.every((t) => t);
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("#")) {
			const dir = line.split(/\s+/)[0];
			const conditional =
				dir === "#if" ||
				dir === "#ifdef" ||
				dir === "#ifndef" ||
				dir === "#else" ||
				dir === "#elif" ||
				dir === "#endif";
			if (conditional) {
				if (dir === "#if" || dir === "#ifdef" || dir === "#ifndef") preproc.push(true);
				else if (dir === "#else" || dir === "#elif") preproc[preproc.length - 1] = false;
				else preproc.pop();
			}
			// File-scope includes/defines are redundant (main.h carries them);
			// the conditional skeleton and anything inside a body is kept.
			const at_file_scope = !conditional && body_depth === 0 && drop_depth === 0;
			if (!at_file_scope) out.push(raw);
			continue;
		}
		const delta = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
		if (body_depth > 0) {
			if (active()) body_depth += delta;
			out.push(raw);
			continue;
		}
		if (drop_depth > 0) {
			if (active()) drop_depth += delta;
			continue;
		}
		if (line.startsWith("//")) continue;
		if (line.startsWith("typedef ")) continue;
		if (line.startsWith("struct ") || line.startsWith("enum ")) {
			// Type shapes live in main.h: drop the body-opening forms, the
			// bare forward declaration, and the one-line enum. Anything else
			// starting with struct/enum is a local declaration inside a
			// function body and must be kept.
			if (line.endsWith("{")) {
				drop_depth += delta;
				continue;
			}
			if (/^(struct|enum) \w+;$/.test(line)) continue;
			if (/^enum \{.*\};$/.test(line)) continue;
		}
		if (active()) body_depth += delta;
		out.push(raw.startsWith("static ") ? raw.slice("static ".length) : raw);
	}
	return out.join("\n");
}

/**
 * Derive the declaration text (extern globals + function prototypes, plus
 * the copied enums/#defines/structs — with `#if`/`#else` skeletons kept so
 * platform-split symbols stay declared on every platform) from the
 * definition blob. Function bodies are dropped; brace matching for finding
 * a body's end counts only the ACTIVE preprocessor branch (the netpoller
 * has `#if __APPLE__` / `#else` alternatives whose brace sets only balance
 * after preprocessing). Throws on a file-scope line it does not recognize —
 * a new definition shape must be taught here, so the declarations can never
 * silently miss a symbol.
 *
 * Defaults to the C backend's blob; the aarch64 companion passes its own
 * (its split shares the runtime the other way — the user companion defines
 * it, the system companion declares it).
 */
export function runtime_declarations(text: string = POOL_HEADER + FIBER_HEADER): string {
	const out: string[] = [];
	let depth = 0; // > 0: inside a struct or function body
	let in_struct = false; // struct/enum body → copied verbatim
	const preproc: boolean[] = []; // per `#if` nest level: is this branch counted?
	const active = (): boolean => preproc.every((t) => t);
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("#")) {
			const dir = line.split(/\s+/)[0];
			if (dir === "#if" || dir === "#ifdef" || dir === "#ifndef") {
				preproc.push(true); // count the first branch; `#else` flips
				if (depth === 0 || in_struct) out.push(raw);
				continue;
			}
			if (dir === "#else" || dir === "#elif") {
				preproc[preproc.length - 1] = false;
				if (depth === 0 || in_struct) out.push(raw);
				continue;
			}
			if (dir === "#endif") {
				preproc.pop();
				if (depth === 0 || in_struct) out.push(raw);
				continue;
			}
			// #include / #define — copied when at file scope
			if (depth === 0 || in_struct) out.push(raw);
			continue;
		}
		const delta = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
		if (depth > 0) {
			if (active()) depth += delta;
			if (in_struct) out.push(raw);
			if (depth === 0) in_struct = false;
			continue;
		}
		if (!line || line.startsWith("//")) continue;
		if (line.startsWith("typedef ")) {
			out.push(raw);
			depth += delta;
			if (depth > 0) in_struct = true;
			continue;
		}
		if (line.startsWith("struct ") || line.startsWith("enum ")) {
			const is_type_shape =
				// body-opening form (`struct X {`)
				line.endsWith("{") ||
				// bare forward declaration (`struct X;`)
				/^(struct|enum) \w+;$/.test(line) ||
				// one-line enum (`enum { A, B };`)
				/^enum \{.*\};$/.test(line);
			if (is_type_shape) {
				out.push(raw);
				depth += delta;
				if (depth > 0) in_struct = true;
				continue;
			}
			// Anything else starting with struct/enum is a VARIABLE whose
			// type is a struct (`struct X *g = NULL;`) — fall through to the
			// declaration forms below.
		}
		if (line.startsWith("static ")) {
			const rest = line.slice("static ".length);
			if (rest.startsWith("__thread ")) {
				// `static __thread T name = init;` → extern declaration
				out.push(`extern __thread ${decl_without_init(rest.slice("__thread ".length))}`);
				continue;
			}
			if (rest.includes("(")) {
				// function definition → prototype (body is skipped above)
				if (line.endsWith("{")) {
					out.push(`${rest.slice(0, -1).trimEnd()};`);
					depth += delta;
					continue;
				}
				if (line.endsWith(";")) {
					out.push(`extern ${rest}`);
					continue;
				}
			} else {
				// variable (initializer optional) → extern declaration
				out.push(`extern ${decl_without_init(rest)}`);
				continue;
			}
		}
		// Non-static forms (the aarch64 runtime blob exports everything):
		// same shapes without the `static ` prefix.
		if (line.startsWith("__thread ")) {
			out.push(`extern __thread ${decl_without_init(line.slice("__thread ".length))}`);
			continue;
		}
		if (line.includes("(")) {
			// function definition → prototype (body is skipped above)
			if (line.endsWith("{")) {
				out.push(`${line.slice(0, -1).trimEnd()};`);
				depth += delta;
				continue;
			}
			if (line.endsWith(";")) {
				// already a prototype — copied verbatim
				out.push(raw);
				continue;
			}
		} else {
			// variable (initializer optional) → extern declaration
			out.push(`extern ${decl_without_init(line)}`);
			continue;
		}
		throw new Error(
			`runtime_declarations: unrecognized file-scope line in the runtime blob: ${JSON.stringify(line)}`,
		);
	}
	if (depth !== 0 || preproc.length !== 0) {
		throw new Error(
			`runtime_declarations: unbalanced runtime blob (brace depth ${depth}, ${preproc.length} open #ifs)`,
		);
	}
	return out.join("\n") + "\n";
}

/** Drop a trailing `= …` initializer (and stray `;`) from a declaration. */
function decl_without_init(rest: string): string {
	const body = rest.replace(/;\s*$/, "");
	const eq = body.indexOf(" = ");
	return (eq === -1 ? body : body.slice(0, eq)) + ";";
}
