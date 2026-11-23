import BaseNode from "./BaseNode.ts";
import type BlockNode from "./BlockNode.ts";
import ImportNode from "./ImportNode.ts";

export default class RootNode extends BaseNode implements BlockNode {
	imports: ImportNode[];
	statements: BaseNode[];

	/**
	 * The compilation's file table (docs/SCOPING.md): parallel arrays
	 * indexed by the `file_id` stamped on declarations. Index 0 is the
	 * entry context; one further entry per `// file://` marker in the
	 * source. Undefined for inline parses with no markers.
	 */
	file_paths?: string[];
	file_namespaces?: string[];

	constructor(imports?: ImportNode[], statements?: BaseNode[]) {
		super("root", 0);
		this.imports = imports || [];
		this.statements = statements || [];
	}
}
