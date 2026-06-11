import type BaseNode from "../../nodes/BaseNode.ts";

export interface VarRefInfo {
	reads: number;
	address_taken: boolean;
}

export default function collect_var_refs(node: BaseNode): Map<string, VarRefInfo> {
	const info = new Map<string, VarRefInfo>();

	function get(name: string): VarRefInfo {
		let entry = info.get(name);
		if (!entry) {
			entry = { reads: 0, address_taken: false };
			info.set(name, entry);
		}
		return entry;
	}

	function is_identifier(val: string): boolean {
		return (
			!!val &&
			!/^(\+|-)?\d+(\.\d+)?$/.test(val) &&
			!val.startsWith('"') &&
			!val.startsWith("'") &&
			val !== "true" &&
			val !== "false" &&
			val !== "null" &&
			val !== "self" &&
			val !== "as"
		);
	}

	function visit(n: BaseNode, in_access_target = false) {
		if (!n) return;
		switch (n.node_type) {
			case "value": {
				const val = (n as any).value as string;
				if (is_identifier(val)) {
					const entry = get(val);
					entry.reads++;
					if (in_access_target) {
						entry.address_taken = true;
					}
				}
				break;
			}
			case "op": {
				const op = n as any;
				visit(op.left_value);
				visit(op.right_value);
				break;
			}
			case "access": {
				const acc = n as any;
				visit(acc.target, true);
				if (acc.access) {
					if (acc.access.node_type === "access_function_call") {
						for (const arg of (acc.access as any).args || []) {
							visit(arg);
						}
					} else if (acc.access.node_type === "access_index") {
						visit((acc.access as any).index);
					}
				}
				break;
			}
			case "declare": {
				const decl = n as any;
				if (decl.value) visit(decl.value);
				break;
			}
			case "if": {
				const ifn = n as any;
				visit(ifn.condition);
				for (const s of ifn.statements || []) visit(s);
				for (const e of ifn.else_statements || []) visit(e);
				break;
			}
			case "while": {
				const wh = n as any;
				visit(wh.condition);
				for (const s of wh.statements || []) visit(s);
				if (wh.update) visit(wh.update);
				break;
			}
			case "for": {
				const f = n as any;
				if (f.list) visit(f.list);
				visit(f.item);
				for (const s of f.statements || []) visit(s);
				if (f.update) visit(f.update);
				break;
			}
			case "return": {
				const ret = n as any;
				if (ret.value) visit(ret.value);
				break;
			}
			case "assign": {
				const asgn = n as any;
				if (asgn.left_value) visit(asgn.left_value);
				if (asgn.right_value) visit(asgn.right_value);
				break;
			}
			case "func_call": {
				const fc = n as any;
				for (const a of fc.params || []) visit(a);
				break;
			}
			case "cast": {
				const c = n as any;
				if (c.value) visit(c.value);
				break;
			}
			default: {
				const any_n = n as any;
				for (const key of [
					"value",
					"left",
					"right",
					"condition",
					"body",
					"true_statements",
					"false_statements",
					"else_statements",
					"statements",
					"update",
					"list",
					"item",
					"args",
					"left_value",
					"right_value",
					"target",
					"index",
				]) {
					const child = any_n[key];
					if (child && typeof child === "object") {
						if (Array.isArray(child)) {
							for (const c of child) {
								if (c && typeof c === "object" && c.node_type) {
									visit(c);
								}
							}
						} else if (child.node_type) {
							visit(child);
						}
					}
				}
				break;
			}
		}
	}

	visit(node);
	return info;
}
