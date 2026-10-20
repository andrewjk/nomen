import add_error from "../../add_error.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import BranchNode from "../../nodes/BranchNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import IfElseNode from "../../nodes/IfElseNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import check_function_node from "../check_function_node.ts";
import type CheckStatus from "../CheckStatus.ts";
import { is_box_type } from "./box.ts";

/**
 * Handler registrations: `.on_<event>(closure)` desugars into owner-dispatched
 * methods (docs/HANDLERS.md, Stage 1 — the root desugar).
 *
 * `self.<field>.on_click(func () { ... })` on a control receiver is
 * checker-interpreted (the name-keyed precedent is the Fiber.start_on
 * rewrite): no code executes at the site. The closure body is HOISTED into a
 * hidden method on the enclosing struct — `#on_click_N = (ref self, ref
 * Window win) { body }` — an ordinary method both backends already lower, and
 * the registration checks into a dispatch ARM appended to the host's
 * synthesized `handle_clicks` method:
 *
 * ```
 * func handle_clicks = (ref self, ref Window win) {
 * 	nomen_window_clicks_init(self.<field>.handle)
 * 	if nomen_control_take_click(self.<field>.handle) { self.#on_click_N(ref win) }
 * }
 * ```
 *
 * `App` declares a default-empty `handle_clicks`; `Window.run` calls
 * `app.handle_clicks(ref win)` before `frame`, so the borrow of `self` is
 * taken by the dispatcher at dispatch time — the closure captures nothing
 * (HANDLERS.md, "The insight"). The arm's handle expression re-evaluates the
 * remembered field path against final fields each frame; nothing is captured,
 * so there is no staleness.
 *
 * Checker rules (one clear error each, HANDLERS.md "Checker rules"):
 *  - the receiver must be a `self`-rooted field path (the arm re-evaluates
 *    it, so a local receiver has nothing to re-evaluate);
 *  - the closure takes no parameters (v1);
 *  - no upvalue captures — the hoisted method has no env;
 *  - host reachability — dispatch reaches hosts through static field paths
 *    from the run root, so the enclosing struct must conform to `App` or be
 *    a (transitive) field of one (library composites are trusted).
 */

/** The reserved member-name family on control receivers (HANDLERS.md). */
const HANDLER_EVENT = /^on_[a-z][a-z0-9_]*$/;

/** The one event the Stage 1 desugar dispatches. */
const SUPPORTED_EVENTS = new Set(["on_click"]);

interface HandlerHostState {
	/** The synthesized trait override, appended to the host's functions. */
	handle_clicks: FunctionNode;
	/** Registration order drives arm order (HANDLERS.md: "in registration order"). */
	next_index: number;
}

/**
 * Per-check synthesis state, keyed by the host struct. Module-level (not on
 * CheckStatus) because `clone_status` copies a fixed field list — state
 * recorded inside a branch clone (a registration nested in an `if`) must
 * survive the clone's discard. The per-check entry in `pending_hosts` dies
 * with the check that created it: `finalize` deletes by status identity, and
 * an aborted compile (parse errors, no check pass) never creates an entry.
 */
const host_states = new WeakMap<StructNode, HandlerHostState>();

/**
 * Hosts awaiting their `handle_clicks` check, keyed by the compile's ROOT
 * node — `status.stack[0]` is the same shared object from every status clone
 * (clone_status shares the stack by reference), so a registration found
 * inside a branch clone still registers under the compile it belongs to.
 */
const pending_hosts = new Map<BaseNode, StructNode[]>();

/**
 * The `.on_<event>(closure)` hook, called from check_access_function_node
 * BEFORE ordinary method resolution. Returns:
 *  - `undefined` — not a handler registration (name family or receiver does
 *    not match); the call resolves ordinarily;
 *  - `false` — a handler registration that failed a checker rule (an error
 *    has been added);
 *  - `true` — desugared: the site is stamped `is_handler_registration` (the
 *    backends emit nothing for it) and the arm is synthesized.
 */
export function try_check_handler_registration(
	target_type: Type,
	target: BaseNode,
	node: AccessFunctionCallNode,
	status: CheckStatus,
): boolean | undefined {
	if (!HANDLER_EVENT.test(node.name)) return undefined;
	// Reserved on CONTROL receivers only: any other type's `on_*` member (or
	// the "Function not found" for a missing one) resolves ordinarily.
	const receiver = status.structs.find((s) => s.name === target_type.name);
	if (!receiver || !receiver.traits.includes("Control")) return undefined;

	const fail = (message: string): false => {
		add_error(status, message, node.start);
		return false;
	};

	if (!SUPPORTED_EVENTS.has(node.name)) {
		return fail(
			`.${node.name} is not a supported handler event yet — only on_click is implemented`,
		);
	}
	if (node.params.length !== 1 || node.params[0].node_type !== "func") {
		return fail(`.${node.name} expects one closure argument — .on_click(func () { ... })`);
	}
	const closure = node.params[0] as FunctionNode;
	if (closure.params.length > 0) {
		return fail(
			"handler closures take no parameters — the body sees `self` and the dispatch `win`",
		);
	}

	// The arm re-evaluates the receiver path at dispatch (against final
	// fields), so the receiver must be a `self`-rooted field path: a local
	// receiver names storage the arm cannot reach after the method returns.
	const fields = self_rooted_field_path(target);
	if (!fields) {
		return fail(
			`.${node.name} needs a self-rooted field receiver — store the control in a field and register from self.<field>.${node.name}(...): the dispatch arm re-evaluates the path, so a local receiver has nothing to re-evaluate`,
		);
	}

	// The host is the struct whose method contains the registration — the
	// hidden methods and the synthesized dispatch become ITS members.
	const enclosing = status.stack.findLast((n) => n.node_type === "func") as
		| FunctionNode
		| undefined;
	const host = enclosing?.scope as StructNode | undefined;
	if (!host || host.node_type !== "struct") {
		return fail(
			`.${node.name} registers a handler on the enclosing struct — it cannot appear outside one`,
		);
	}
	// Host reachability (HANDLERS.md "Checker rules"): dispatch reaches hosts
	// through static field paths from the run root, so the enclosing struct
	// must conform to `App` or be a (transitive) field of one. Library
	// composites (Pagination) are trusted machinery — the System library is
	// exempt, as everywhere the checker trusts library internals; a program
	// that hosts one gets the forwarding wiring synthesized at finalize.
	if (!host.traits.includes("App") && !host.is_library && !reachable_from_an_app(host, status)) {
		return fail(`handlers dispatch from the run root — '${host.name}' is not owned by the app`);
	}
	let state = host_states.get(host);
	if (!state) {
		// A USER-declared handle_clicks would collide with the synthesized
		// override (the name is reserved on handler hosts). Past this point a
		// same-named method is our own synthesis from an earlier registration.
		if (host.functions.some((f) => f.name === "handle_clicks")) {
			return fail(
				`'${host.name}' already declares handle_clicks — the .${node.name} desugar synthesizes it (the name is reserved on handler hosts)`,
			);
		}
		const handle_clicks = new FunctionNode(node.start, "pub", "handle_clicks", new Type(""), [
			ref_self_param(host),
			win_param(),
		]);
		host.functions.push(handle_clicks);
		state = { handle_clicks, next_index: 1 };
		host_states.set(host, state);
		const root = status.stack[0];
		let hosts = pending_hosts.get(root);
		if (!hosts) {
			hosts = [];
			pending_hosts.set(root, hosts);
		}
		hosts.push(host);
	}
	const index = state.next_index++;

	// ── The hoist ──
	// The closure body becomes the hidden method's body, VERBATIM. The method
	// is checked as a closure WOULD BE (is_closure stamped for the duration):
	// any reference that resolves outside the body is recorded as a capture,
	// and captures are the v1 error — the hoisted method has no env. `self`
	// and `win` never capture: the hoisted method declares its own receiver
	// and dispatch-window parameters, which the body's references resolve to.
	const hoisted = new FunctionNode(
		closure.start,
		"private",
		`#on_click_${index}`,
		new Type(""),
		[ref_self_param(host), win_param()],
		closure.statements,
	);
	host.functions.push(hoisted);
	hoisted.is_closure = true;
	check_function_node(hoisted, status);
	const upvalues = hoisted.captures ?? [];
	hoisted.is_closure = undefined;
	hoisted.captures = undefined;
	if (upvalues.length) {
		return fail(
			"handler closures see `self` and the dispatch `win` — copy what you need into fields",
		);
	}

	// ── The arm ── (registration order; the drain drains only its own handle,
	// so arms never starve each other or a was_clicked poll.)
	state.handle_clicks.statements.push(
		arm_init_statement(host, fields, node.start),
		arm_dispatch_statement(host, fields, index, node.start),
	);

	// The registration site emits no code at all.
	node.is_handler_registration = true;
	node.type = new Type("");
	return true;
}

/**
 * Check every host's synthesized `handle_clicks`, after first synthesizing
 * the FORWARDING wiring (Stage 2, HANDLERS.md "Handler hosts beyond the
 * root"): a struct with registrations is a handler host — not just the App.
 * Dispatch reaches non-root hosts down static field paths: every struct on a
 * path from an App conformer to a host gets a `handle_clicks` (its own arms
 * if it registers, pure forwarding if it doesn't) that forwards to each
 * host-reaching field — `self.<field>.handle_clicks(ref win)` — direct
 * calls, no trait objects. Dispatch order is children-first, then own arms
 * (most specific first, HANDLERS.md "user-authored composites").
 *
 * Runs once, after the whole tree has been checked: the arms reference the
 * hidden `#on_click_N` methods (checked at their registration sites), the
 * drain (`nomen_control_take_click`) and the `Window` type are resolved, and
 * the full field graph (gathered upfront) decides reachability. Checking the
 * bodies also stamps every node for the build.
 */
export function finalize_handler_hosts(status: CheckStatus): void {
	const root = status.stack[0];
	const hosts = pending_hosts.get(root);
	if (!hosts) return;
	pending_hosts.delete(root);
	const host_set = new Set<StructNode>(hosts);

	const to_check: FunctionNode[] = [];
	for (const host of hosts) {
		const state = host_states.get(host);
		if (state) to_check.push(state.handle_clicks);
	}

	// Does `s` (or anything it owns down forwardable fields) carry handlers?
	const reaches_memo = new Map<StructNode, boolean>();
	const reaches_host = (s: StructNode, stack: Set<StructNode>): boolean => {
		if (host_set.has(s)) return true;
		const memo = reaches_memo.get(s);
		if (memo !== undefined) return memo;
		if (stack.has(s)) return false;
		stack.add(s);
		let result = false;
		for (const field of s.fields) {
			const t = forwardable_field_type(field, status);
			if (t && reaches_host(t, stack)) {
				result = true;
				break;
			}
		}
		stack.delete(s);
		reaches_memo.set(s, result);
		return result;
	};

	for (const s of status.structs) {
		const forwarding = s.fields.filter((f) => {
			const t = forwardable_field_type(f, status);
			return !!t && reaches_host(t, new Set());
		});
		if (forwarding.length === 0) continue;
		// Who gets a dispatch body: App conformers (the run root drains them),
		// hosts (their arms), and structs an App reaches that lead further
		// down to a host (pure forwarders). Anything else is a dead chain.
		const is_app = s.traits.includes("App");
		const is_host = host_set.has(s);
		if (!is_app && !is_host && !reachable_from_an_app(s, status)) continue;
		let state = host_states.get(s);
		if (!state) {
			// A pure forwarder (or an App conformer whose only handlers live
			// in its composites). A user-declared handle_clicks is left alone.
			if (s.functions.some((f) => f.name === "handle_clicks")) continue;
			const handle_clicks = new FunctionNode(-1, "pub", "handle_clicks", new Type(""), [
				ref_self_param(s),
				win_param(),
			]);
			s.functions.push(handle_clicks);
			state = { handle_clicks, next_index: 0 };
			host_states.set(s, state);
			to_check.push(handle_clicks);
		}
		// Children-first: forwarding splices ahead of the host's own arms.
		state.handle_clicks.statements.unshift(...forwarding.map((f) => forward_statement(s, f.name)));
	}

	for (const hc of to_check) {
		check_function_node(hc, status);
	}
}

/**
 * The field types dispatch may FORWARD through: direct, owned, concrete
 * struct fields. Boxes/containers/monos/generics are element-dispatch
 * territory (B5, Stage 4) and stop the walk; nullable/borrowed/array fields
 * have no single static target.
 */
function forwardable_field_type(
	field: { type: Type },
	status: CheckStatus,
): StructNode | undefined {
	const type = field.type;
	if (!type.name || type.is_ref || type.is_view || type.is_array || type.is_nullable) {
		return undefined;
	}
	if (is_box_type(type.name, status.structs)) return undefined;
	const s = status.structs.find((st) => st.name === type.name);
	if (!s) return undefined;
	// A monomorphized instance of a generic (List_Pager, Box_Pager, …) or a
	// raw generic template: no static single-instance path.
	if (s.source_type_args?.length || s.type_params.length > 0) return undefined;
	return s;
}

/** Whether some App conformer reaches `target` down forwardable field paths. */
function reachable_from_an_app(target: StructNode, status: CheckStatus): boolean {
	for (const s of status.structs) {
		if (!s.traits.includes("App")) continue;
		if (path_exists(s, target, status, new Set())) return true;
	}
	return false;
}

function path_exists(
	s: StructNode,
	target: StructNode,
	status: CheckStatus,
	stack: Set<StructNode>,
): boolean {
	if (s === target) return true;
	if (stack.has(s)) return false;
	stack.add(s);
	for (const field of s.fields) {
		const t = forwardable_field_type(field, status);
		if (t && path_exists(t, target, status, stack)) return true;
	}
	stack.delete(s);
	return false;
}

/** `self.<field>.handle_clicks(ref win)` — one hop down the ownership path. */
function forward_statement(host: StructNode, field: string): AccessNode {
	const receiver = new AccessNode(
		-1,
		new ValueNode(-1, "self", new Type(host.name)),
		new AccessFieldNode(-1, field),
	);
	const dispatch = new AccessFunctionCallNode(-1, "handle_clicks");
	// `ref win` — the borrowed argument needs the same explicit `ref` a source
	// call site writes (ref_param_indices marks the keyword positions).
	dispatch.ref_param_indices = [0];
	dispatch.params = [new ValueNode(-1, "win")];
	return new AccessNode(-1, receiver, dispatch);
}

/** `ref self` — the hoisted method's receiver (the host instance). */
function ref_self_param(host: StructNode): ParameterNode {
	const param = new ParameterNode(-1, "self", new Type(host.name));
	param.is_self_param = true;
	param.is_ref = true;
	param.declaration = "var";
	return param;
}

/** `ref Window win` — the dispatch window, lent by the run loop per frame. */
function win_param(): ParameterNode {
	const type = new Type("Window");
	type.is_ref = true;
	return new ParameterNode(-1, "win", type);
}

/**
 * The registration receiver's field path when it is `self`-rooted:
 * `self.add_btn` → `["add_btn"]`, `self.pager.prev` → `["pager", "prev"]`.
 * Undefined for any other shape (a bare local, a call result, …).
 */
function self_rooted_field_path(target: BaseNode): string[] | undefined {
	const fields: string[] = [];
	let current = target;
	while (current.node_type === "access") {
		const access = current as AccessNode;
		if (access.access.node_type !== "access_field") return undefined;
		fields.unshift((access.access as AccessFieldNode).name);
		current = access.target;
	}
	if (current.node_type !== "value" || (current as ValueNode).value !== "self") {
		return undefined;
	}
	if (fields.length === 0) return undefined;
	return fields;
}

/** The receiver path re-emitted for the arm: `self.a.b` (handle expression). */
function arm_receiver(host: StructNode, fields: string[], start: number): BaseNode {
	let receiver: BaseNode = new ValueNode(start, "self", new Type(host.name));
	for (const field of fields) {
		receiver = new AccessNode(start, receiver, new AccessFieldNode(start, field));
	}
	return receiver;
}

/**
 * First-dispatch arming for the registered view: covers non-button controls
 * (buttons arm target/action at construction). `nomen_window_clicks_init` is
 * idempotent per handle, so the per-frame call is a no-op after the first.
 */
function arm_init_statement(host: StructNode, fields: string[], start: number): FunctionCallNode {
	const handle = new AccessNode(
		start,
		arm_receiver(host, fields, start),
		new AccessFieldNode(start, "handle"),
	);
	return new FunctionCallNode(start, "nomen_window_clicks_init", new Type(""), [handle]);
}

/**
 * `if nomen_control_take_click(self.<path>.handle) { self.#on_click_N(ref win) }`
 */
function arm_dispatch_statement(
	host: StructNode,
	fields: string[],
	index: number,
	start: number,
): IfElseNode {
	const handle = new AccessNode(
		start,
		arm_receiver(host, fields, start),
		new AccessFieldNode(start, "handle"),
	);
	const condition = new FunctionCallNode(start, "nomen_control_take_click", new Type("bool"), [
		handle,
	]);
	const dispatch = new AccessFunctionCallNode(start, `#on_click_${index}`);
	// `ref win` — the borrowed argument needs the same explicit `ref` a source
	// call site writes (ref_param_indices marks the keyword positions).
	dispatch.ref_param_indices = [0];
	dispatch.params = [new ValueNode(start, "win")];
	const call = new AccessNode(start, new ValueNode(start, "self", new Type(host.name)), dispatch);
	return new IfElseNode(start, condition, new BranchNode(start, [call]));
}
