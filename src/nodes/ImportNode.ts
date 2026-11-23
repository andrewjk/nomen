import BaseNode from "./BaseNode.ts";

export default class ImportNode extends BaseNode {
	name: string;

	/**
	 * The namespace this import grants access to (docs/SCOPING.md): the
	 * namespace of its resolved target's directory — `import System` grants
	 * `"System"`, `import System::Controls` grants `"System::Controls"`,
	 * a module-file import (`import System::Text::Regex`) grants the file's
	 * directory namespace (`"System::Text"`). Computed by parse from the
	 * file table and the library layout.
	 */
	granted_namespace?: string;

	constructor(start: number, name: string) {
		super("import", start);
		this.name = name;
	}
}
