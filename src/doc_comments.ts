import type BaseNode from "./nodes/BaseNode.ts";
import type RootNode from "./nodes/RootNode.ts";
import type StructNode from "./nodes/StructNode.ts";
import type TraitNode from "./nodes/TraitNode.ts";

export interface DocComment {
	start: number;
	end: number;
	raw: string;
}

/** Find every documentation block comment in `source`, with positions. */
export function extract_doc_comments(source: string): DocComment[] {
	const docs: DocComment[] = [];
	for (let i = 0; i < source.length; i++) {
		if (source[i] === "/" && source[i + 1] === "*" && source[i + 2] === "*") {
			const end = find_block_end(source, i);
			docs.push({ start: i, end, raw: source.substring(i, end) });
			i = end - 1;
		}
	}
	return docs;
}

// Depth-counted scan (mirrors the tokenizer's block-comment consumer, so nested
// `/* */` inside a doc comment is handled). Returns the index just past the close.
function find_block_end(source: string, start: number): number {
	let depth = 0;
	for (let j = start; j < source.length; j++) {
		if (source[j] === "/" && source[j + 1] === "*") depth += 1;
		else if (source[j] === "*" && source[j + 1] === "/") {
			depth -= 1;
			if (depth === 0) return j + 2;
		}
	}
	return source.length;
}

/**
 * Turn a raw documentation block into clean text: strip the delimiters and the
 * per-line ` * ` prefixes, and trim leading/trailing blank lines. The `@tag`
 * lines (e.g. `@param`, `@out`) are preserved verbatim.
 */
export function clean_doc_comment(raw: string): string {
	let body = raw.replace(/^\/\*+/, "").replace(/\*+\/\s*$/, "");
	const lines = body.split("\n").map((line) => line.replace(/^\s*\* ?/, ""));
	while (lines.length && lines[0].trim() === "") lines.shift();
	while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
	return lines.join("\n").trimEnd();
}

/**
 * Attach each doc comment to the declaration node it immediately precedes. A
 * doc comment applies to the next documentable node (struct/trait/enum/bitset/
 * func/declare) whose `start` is at or after the comment's end; when several
 * precede a node, the nearest one wins.
 */
export function attach_doc_comments(root: RootNode, source: string): void {
	const docs = extract_doc_comments(source);
	if (!docs.length) return;
	const nodes: BaseNode[] = [];
	collect_documentable(root, nodes);
	for (const node of nodes) {
		// Nearest doc comment ending at or before this node's start.
		let best: DocComment | undefined;
		for (const doc of docs) {
			if (doc.end <= node.start && (!best || doc.end > best.end)) best = doc;
		}
		// ...but only if nothing but whitespace (and line comments) sits between
		// them — otherwise the doc belongs to an earlier declaration and would
		// falsely leak across the concatenated library source.
		if (
			best &&
			source
				.substring(best.end, node.start)
				.replace(/\/\/[^\n]*/g, "")
				.trim() === ""
		) {
			node.doc = clean_doc_comment(best.raw);
		}
	}
}

// Gather every declaration node that can carry a doc comment: top-level
// declarations plus struct/trait methods and fields. Order doesn't matter —
// attachment is by position.
function collect_documentable(root: RootNode, out: BaseNode[]): void {
	for (const stmt of root.statements) collect_node(stmt, out);
}

function collect_node(node: BaseNode, out: BaseNode[]): void {
	switch (node.node_type) {
		case "struct": {
			const s = node as unknown as StructNode;
			out.push(s);
			for (const f of s.functions) collect_node(f, out);
			for (const field of s.fields) out.push(field);
			break;
		}
		case "trait": {
			const t = node as unknown as TraitNode;
			out.push(t);
			for (const f of t.functions) collect_node(f, out);
			for (const field of t.fields) out.push(field);
			break;
		}
		case "enum":
		case "bitset":
		case "func":
		case "declare":
			out.push(node);
			break;
	}
}
