import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import clone_node from "../nodes/clone_node.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import parse_statement from "./parse_statement.ts";
import parse_type from "./parse_type.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import consume_name from "./utils/consume_name.ts";
import expect from "./utils/expect.ts";
import expect_close_angle from "./utils/expect_close_angle.ts";
import get_index from "./utils/get_index.ts";

export default function parse_struct(
	visibility: "pub" | "private" | "internal",
	status: ParseStatus,
	is_owning = false,
) {
	const start = get_index(status);
	accept(visibility, status);
	if (is_owning) accept("mv", status);
	accept("struct", status);
	const name = consume_name(status);
	const struct = new StructNode(start, visibility, name);
	if (is_owning) struct.is_owning = true;

	if (accept("<", status)) {
		struct.type_params.push(consume_name(status));
		struct.type_param_bounds.push(parse_optional_type_param_bound(status));
		while (accept(",", status)) {
			struct.type_params.push(consume_name(status));
			struct.type_param_bounds.push(parse_optional_type_param_bound(status));
		}
		expect_close_angle(status);
	}

	const old_namespace = status.namespace;
	status.namespace += `.${name}`;

	if (accept(":", status)) {
		// Each conformance is a trait name optionally followed by concrete
		// type arguments (`struct Users: Viewable<User>`). The base name is
		// stored in `traits` (used for vtable dispatch); the args land in the
		// parallel `trait_args` array and are arity-checked later.
		struct.traits.push(consume(status));
		struct.trait_args.push(parse_optional_trait_args(status));
		while (accept(",", status)) {
			struct.traits.push(consume(status));
			struct.trait_args.push(parse_optional_trait_args(status));
		}
	}

	if (expect("{", status)) {
		status.stack.push(struct);
		parse_statement(status);
		expect("}", status);
		status.stack.pop();

		// A `#spawn` construction hook (ASYNC.md) suppresses the
		// default `#init` too: the class constructs through the compiler's
		// deferred-call special form, not an ordinary constructor.
		const has_custom_init = struct.functions.some((f) => f.name === "#init" || f.name === "#spawn");
		if (!has_custom_init) {
			const func = new FunctionNode(-1, visibility, "#init", new Type(struct.name));
			func.params = struct.fields
				.filter((f) => f.visibility !== "private" && !f.value)
				.map((f) => {
					// A func-typed field's ctor param carries the SIGNATURE so a
					// lambda argument (`Rule((x) => …)`) can infer its parameter
					// types, exactly like a func-typed local's declaration does.
					const param = new ParameterNode(-1, f.name, f.func_params ? new Type("func") : f.type);
					if (f.func_params) {
						param.func_params = f.func_params;
						param.func_return_type = f.func_return_type;
					}
					if (f.declaration === "mv") {
						param.is_moved = true;
					}
					param.constraint = f.constraint;
					return param;
				});
			func.is_static = true;
			struct.functions.unshift(func);
		}

		add_to_parent(struct, "Struct", status);

		// A `#handle` construction hook: synthesize the copyable Handle
		// twin — `<Name>Handle`, a NON-mv struct (assignment, params, and
		// closure captures all COPY it; copies never destroy — the owning
		// struct releases the resource exactly once). It mirrors every
		// public bare-self method (bodies transplant verbatim: the twin
		// carries the same `handle` field the raw bodies read), plus an
		// `#init(owner)` minter copying the owner's handle. This is what
		// lets closures capture controls without the capture-MOVES rule
		// (CLOSURE.md): the captured value owns nothing.
		const has_handle_hook = struct.functions.some((f) => f.name === "#handle");
		if (has_handle_hook) {
			struct.functions = struct.functions.filter((f) => f.name !== "#handle");
			add_to_parent(synthesize_handle_struct(struct, start, visibility), "Struct", status);
		}
	}

	status.namespace = old_namespace;
}

// Parse optional `<arg1, arg2, ...>` type arguments on a trait conformance.
// Returns undefined when no `<...>` follows, so non-generic conformance
// (`struct Foo: Disposable`) is unchanged. Shared with parse_extend for
// out-of-line conformance (`extend struct Foo: Disposable<T> { ... }`).
export function parse_optional_trait_args(status: ParseStatus): Type[] | undefined {
	if (!accept("<", status)) return undefined;
	const args: Type[] = [parse_type(status)];
	while (accept(",", status)) {
		args.push(parse_type(status));
	}
	expect_close_angle(status);
	return args;
}

// Parse an optional trait bound on a struct type parameter: the `: Control`
// in `struct Container<T: Control>`. Returns the bound trait name, or empty
// string when the param is unbounded. Multiple bounds may be listed,
// `+`-separated (`<T: A + B>`); each is stored so the checker can validate
// conformance at monomorphization.
function parse_optional_type_param_bound(status: ParseStatus): string[] {
	if (!accept(":", status)) return [];
	const bounds: string[] = [consume(status)];
	while (accept("+", status)) {
		bounds.push(consume(status));
	}
	return bounds;
}

// Synthesize the `<Name>Handle` twin for a struct carrying the `#handle`
// hook (see the struct-close synthesis in parse_struct): a NON-mv struct —
// copies are data copies of the native handle, so nothing moves and nothing
// destroys — with mirrors of every public bare-self method and an
// `#init(owner)` minter. Raw bodies transplant verbatim because the twin
// carries the same `handle` field the bodies read; methods taking `ref
// self`, statics, and `#` lifecycle members are not mirrored (a view never
// constructs or releases). The synthesized nodes reuse the owner's `start`
// offset so the library raw-block boundary classification is inherited.
function synthesize_handle_struct(
	struct: StructNode,
	start: number,
	visibility: "pub" | "private" | "internal",
): StructNode {
	if (struct.type_params.length > 0) {
		throw new Error(`#handle is not supported on generic struct '${struct.name}' yet`);
	}
	const handle = new StructNode(start, visibility, `${struct.name}Handle`);
	handle.is_owning = false;
	handle.fields.push(new DeclarationNode(start, "internal", "var", "handle", new Type("uint64")));

	// The minter: `TextBoxHandle(owner)` — copies the owner's native handle.
	// `from` is a bare (borrowed) parameter, so the call site needs no `mv`.
	const init = new FunctionNode(start, visibility, "#init", new Type(handle.name));
	const self_param = new ParameterNode(start, "self", new Type(handle.name));
	self_param.is_self_param = true;
	self_param.declaration = "var";
	const from_param = new ParameterNode(start, "from", new Type(struct.name));
	init.params = [self_param, from_param];
	init.is_static = false;
	init.has_body = true;
	init.statements = [
		new AssignmentNode(
			start,
			new AccessNode(
				start,
				new ValueNode(start, "self", new Type(handle.name)),
				new AccessFieldNode(start, "handle", new Type("uint64")),
			),
			new AccessNode(
				start,
				new ValueNode(start, "from", new Type(struct.name)),
				new AccessFieldNode(start, "handle", new Type("uint64")),
			),
		),
	];
	handle.functions.push(init);

	// Mirror every public bare-self method. Clones are plain data (the AST
	// is JSON-safe), so a structured clone is a faithful deep copy; only the
	// receiver's type is rewritten to the Handle.
	for (const func of struct.functions) {
		if (func.visibility !== "pub") continue;
		if (func.name.startsWith("#")) continue;
		const receiver = func.params[0];
		if (!receiver || !receiver.is_self_param) continue;
		if (receiver.is_ref) continue; // ref methods mutate the owner — not mirrored
		const clone = clone_node(func) as unknown as FunctionNode;
		clone.start = start;
		clone.visibility = "pub";
		clone.params[0].type = new Type(handle.name);
		handle.functions.push(clone);
	}
	return handle;
}
