import add_error from "../../add_error.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import AssignmentNode from "../../nodes/AssignmentNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import BranchNode from "../../nodes/BranchNode.ts";
import DeclarationNode from "../../nodes/DeclarationNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import IfElseNode from "../../nodes/IfElseNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import WhileLoopNode from "../../nodes/WhileLoopNode.ts";
import { check_access_function_node } from "../check_access_node.ts";
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

/**
 * The control-carried event table: event name → the library drain primitive
 * the synthesized arm polls, the optional per-arm ARMING prologue, and the
 * per-event dispatcher the arm belongs to. Focus and blur share a
 * dispatcher (one first-responder snapshot poll frames both edges —
 * docs/HANDLERS.md, "Registered control events").
 */
interface ControlEventConfig {
	drain: string;
	arm?: string;
	dispatcher: string;
	/** Once-per-dispatcher prologue: refreshes the event source snapshot. */
	prologue?: string;
}

const CONTROL_EVENTS: Record<string, ControlEventConfig> = {
	on_click: {
		drain: "nomen_control_take_click",
		arm: "nomen_window_clicks_init",
		dispatcher: "handle_clicks",
	},
	on_focus: {
		drain: "nomen_control_take_focus",
		dispatcher: "handle_focus",
		prologue: "nomen_window_focus_poll",
	},
	on_blur: {
		drain: "nomen_control_take_blur",
		dispatcher: "handle_focus",
		prologue: "nomen_window_focus_poll",
	},
	on_input: {
		drain: "nomen_control_take_input",
		dispatcher: "handle_input",
	},
};

/** The dispatchers awaiting their final check, per compile root. */
const pending_dispatchers = new Map<BaseNode, { host: StructNode; dispatcher: string }[]>();

interface DispatcherState {
	/** The synthesized trait override, appended to the host's functions. */
	func: FunctionNode;
	/** Per-event hidden-method counters (registration order drives arms). */
	next_index: Map<string, number>;
}

/**
 * Per-check synthesis state, keyed by the host struct and dispatcher name.
 * Module-level (not on CheckStatus) because `clone_status` copies a fixed
 * field list — state recorded inside a branch clone (a registration nested
 * in an `if`) must survive the clone's discard. The per-check entry in
 * `pending_hosts` dies with the check that created it: `finalize` deletes by
 * root identity, and an aborted compile (parse errors, no check pass) never
 * creates an entry.
 */
const dispatcher_states = new WeakMap<StructNode, Map<string, DispatcherState>>();

const host_states = new WeakMap<StructNode, Map<string, DispatcherState>>();

/**
 * Hosts awaiting their `handle_clicks` check, keyed by the compile's ROOT
 * node — `status.stack[0]` is the same shared object from every status clone
 * (clone_status shares the stack by reference), so a registration found
 * inside a branch clone still registers under the compile it belongs to.
 */
const pending_hosts = new Map<BaseNode, StructNode[]>();

interface RunHandlerState {
	/** The synthesized trait override, appended to the app's functions. */
	run_handler: FunctionNode;
	/** Registration order assigns dispatch ids (HANDLERS.md Stage 3). */
	next_id: number;
}

/** Per-app up-call synthesis state (see host_states for why module-level). */
const run_handler_states = new WeakMap<StructNode, RunHandlerState>();

/** Apps whose synthesized `run_handler` awaits its check (see pending_hosts). */
const pending_run_handlers = new Map<BaseNode, StructNode[]>();

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
	// The Stage 3 enrollment rewrite re-enters this hook with the site
	// already rewritten to `receiver.on_<event>(id)` — resolve ordinarily.
	if (node.is_handler_enrollment) return undefined;
	if (!HANDLER_EVENT.test(node.name)) return undefined;
	// Reserved on CONTROL receivers only: any other type's `on_*` member (or
	// the "Function not found" for a missing one) resolves ordinarily.
	const receiver = status.structs.find((s) => s.name === target_type.name);
	if (!receiver) return undefined;

	const fail = (message: string): false => {
		add_error(status, message, node.start);
		return false;
	};

	// Click handlers ride on CONTROL receivers (any other type's `on_click`
	// member — or the "Function not found" for a missing one — resolves
	// ordinarily).
	if (node.name === "on_click") {
		if (!receiver.traits.includes("Control")) return undefined;
		return try_check_control_event(
			receiver,
			target_type,
			target,
			node,
			status,
			fail,
			CONTROL_EVENTS[node.name],
		);
	}
	if (receiver.traits.includes("Control")) {
		// The on_<event> family is reserved on control receivers: a
		// table-backed event dispatches; anything else is a named error
		// rather than a confusing "Function not found".
		const cfg = CONTROL_EVENTS[node.name];
		if (cfg) {
			return try_check_control_event(
				receiver,
				target_type,
				target,
				node,
				status,
				fail,
				CONTROL_EVENTS[node.name],
			);
		}
		return fail(
			`.${node.name} is not a supported handler event — supported: on_click, on_focus, on_blur, on_input`,
		);
	}
	// Composite event APIs (Stage 3): `self.pager.on_page_change(func () {
	// ... })` enrolls an up-call handler on a composite host — the composite
	// declares the event API, so any on_<event> can be a composite event.
	return try_check_composite_event(receiver, target_type, target, node, status, fail);
}

/**
 * The control-carried event path (docs/HANDLERS.md, "Registered control
 * events"): the event comes from the CONTROL's own source (the click ring,
 * the window's first responder, the control's text), the synthesized arm
 * polls that source's drain primitive, and the hidden method hoists onto
 * the App conformer the way the click desugar does. Config comes from
 * CONTROL_EVENTS; everything here is event-agnostic.
 */
function try_check_control_event(
	receiver: StructNode,
	target_type: Type,
	target: BaseNode,
	node: AccessFunctionCallNode,
	status: CheckStatus,
	fail: (message: string) => false,
	cfg: ControlEventConfig,
): boolean {
	if (node.params.length !== 1 || node.params[0].node_type !== "func") {
		return fail(`.${node.name} expects one closure argument — .${node.name}(func () { ... })`);
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

	// The dispatcher (per host + event family): get or synthesize. A
	// USER-declared same-named method would collide with the synthesized
	// override (the name is reserved on hosts with registrations). Past this
	// point a same-named method is our own synthesis from an earlier
	// registration.
	let dispatchers = dispatcher_states.get(host);
	if (!dispatchers) {
		dispatchers = new Map();
		dispatcher_states.set(host, dispatchers);
	}
	let state = dispatchers.get(cfg.dispatcher);
	if (!state) {
		if (host.functions.some((f) => f.name === cfg.dispatcher)) {
			return fail(
				`'${host.name}' already declares ${cfg.dispatcher} — the .${node.name} desugar synthesizes it (the name is reserved on handler hosts)`,
			);
		}
		const func = new FunctionNode(node.start, "pub", cfg.dispatcher, new Type(""), [
			ref_self_param(host),
			win_param(),
		]);
		host.functions.push(func);
		state = { func, next_index: new Map() };
		dispatchers.set(cfg.dispatcher, state);
		const root = status.stack[0];
		if (cfg.dispatcher === "handle_clicks") {
			let hosts = pending_hosts.get(root);
			if (!hosts) {
				hosts = [];
				pending_hosts.set(root, hosts);
			}
			hosts.push(host);
		} else {
			let entries = pending_dispatchers.get(root);
			if (!entries) {
				entries = [];
				pending_dispatchers.set(root, entries);
			}
			entries.push({ host, dispatcher: cfg.dispatcher });
		}
		if (cfg.prologue) {
			// Once-per-frame event-source refresh, emitted ahead of the arms
			// (the focus snapshot frames every focus/blur edge in the frame).
			state.func.statements.push(prologue_statement(cfg.prologue, node.start));
		}
	}
	let index_state = state.next_index.get(node.name);
	if (index_state === undefined) {
		index_state = 1;
	} else {
		index_state += 1;
	}
	state.next_index.set(node.name, index_state);
	const index = index_state;
	const hidden = `#${node.name}_${index}`;

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
		`#${node.name}_${index}`,
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

	// ── The arm ── (registration order; each arm drains only its own
	// registered handle, so arms never starve each other or a was_clicked
	// poll.) The click family arms its native source per arm; the passive
	// events (focus/blur/input) poll and need no arming.
	const arm_target = arm_receiver(host, fields, node.start);
	if (cfg.arm) {
		state.func.statements.push(arm_init_statement(cfg.arm, arm_target, node.start));
	}
	state.func.statements.push(arm_dispatch_statement(host, fields, cfg.drain, hidden, node.start));

	// The registration site emits no code at all.
	node.is_handler_registration = true;
	node.type = new Type("");
	return true;
}

/**
 * The once-per-dispatcher event-source refresh:
 * `nomen_window_focus_poll(win.handle)` for the focus family.
 */
function prologue_statement(primitive: string, start: number): FunctionCallNode {
	const handle = new AccessNode(
		start,
		new ValueNode(start, "win"),
		new AccessFieldNode(start, "handle"),
	);
	return new FunctionCallNode(start, primitive, new Type(""), [handle]);
}

/**
 * Composite event registration (docs/HANDLERS.md Stage 3 — id up-calls).
 * `self.<field>.on_<event>(closure)` on a composite host — a struct that
 * DECLARES the event API — enrolls the app handler for the composite's
 * up-call:
 *
 *  - the closure hoists into a hidden method on the app —
 *    `#on_<event>_N = (ref self, ref Window win) { body }`;
 *  - the app's synthesized `run_handler` gains the dispatch arm
 *    `if id == N { self.#on_<event>_N(ref win) }` — the concrete method the
 *    composite's `owner.run_handler(id, ref win)` callback hops into;
 *  - the registration site REWRITES to the enrollment call
 *    `receiver.on_<event>(N)` — the composite's own declared API stores the
 *    id (the one thing tier 2 stores: an int, never a handler).
 *
 * The composite opts in by declaration: the event exists when the receiver
 * declares `func on_<event> = (ref self, int id)`. Without it the name
 * resolves ordinarily ("Function not found") — the family is not reserved
 * on composites, only on controls.
 *
 * The closure rules match the click desugar (no parameters, no upvalue
 * captures, self-rooted field receiver), and the enclosing host must be the
 * App conformer — the up-call dispatches through the app's `run_handler`.
 * Returns undefined when this isn't a declared composite event.
 */
function try_check_composite_event(
	receiver: StructNode,
	target_type: Type,
	target: BaseNode,
	node: AccessFunctionCallNode,
	status: CheckStatus,
	fail: (message: string) => false,
): boolean | undefined {
	// Opt-in by declaration: one `on_<event> = (ref self, int id)` method.
	const enrollment = receiver.functions.find(
		(f) =>
			f.name === node.name &&
			f.params.length === 2 &&
			f.params[0].is_self_param &&
			!f.params[1].is_self_param &&
			f.params[1].type.name === "int" &&
			!f.params[1].type.is_ref,
	);
	if (!enrollment) return undefined;

	if (node.params.length !== 1 || node.params[0].node_type !== "func") {
		return fail(`.${node.name} expects one closure argument — .${node.name}(func () { ... })`);
	}
	const closure = node.params[0] as FunctionNode;
	if (closure.params.length > 0) {
		return fail(
			"handler closures take no parameters — the body sees `self` and the dispatch `win`",
		);
	}

	// The receiver path and host rules match the click desugar (v1: the
	// up-call dispatches through the app's run_handler, so the handler
	// hoists onto the App conformer).
	const fields = self_rooted_field_path(target);
	if (!fields) {
		return fail(
			`.${node.name} needs a self-rooted field receiver — store the composite in a field and register from self.<field>.${node.name}(...)`,
		);
	}
	const enclosing = status.stack.findLast((n) => n.node_type === "func") as
		| FunctionNode
		| undefined;
	const host = enclosing?.scope as StructNode | undefined;
	if (!host || host.node_type !== "struct") {
		return fail(
			`.${node.name} registers a handler on the enclosing struct — it cannot appear outside one`,
		);
	}
	if (!host.traits.includes("App")) {
		return fail(
			`up-call handlers dispatch through the app's run_handler — register .${node.name} from the app, not from '${host.name}'`,
		);
	}
	if (host.functions.some((f) => f.name === "run_handler")) {
		return fail(
			`'${host.name}' already declares run_handler — the .${node.name} desugar synthesizes it (the name is reserved on the app)`,
		);
	}

	// Per-app synthesis state (the run_handler override + the id counter).
	const root = status.stack[0];
	let state = run_handler_states.get(host);
	if (!state) {
		const run_handler = new FunctionNode(node.start, "pub", "run_handler", new Type(""), [
			ref_self_param(host),
			new ParameterNode(node.start, "id", new Type("int")),
			win_param(),
		]);
		host.functions.push(run_handler);
		state = { run_handler, next_id: 1 };
		run_handler_states.set(host, state);
		let apps = pending_run_handlers.get(root);
		if (!apps) {
			apps = [];
			pending_run_handlers.set(root, apps);
		}
		apps.push(host);
	}
	const id = state.next_id++;

	// ── The hoist ── (identical discipline to the click desugar: checked as
	// a closure WOULD BE, so upvalue references record as captures — the
	// v1 error. `self` and `win` resolve to the hoisted method's params.)
	const hoisted = new FunctionNode(
		closure.start,
		"private",
		`#${node.name}_${id}`,
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

	// ── The dispatch arm ── (registration order; ids arrive per tick.)
	state.run_handler.statements.push(up_call_arm(host, node.name, id, node.start));

	// ── The enrollment rewrite ──: the site becomes
	// `receiver.on_<event>(N)` and resolves as the composite's declared API.
	node.is_handler_enrollment = true;
	node.params = [new ValueNode(node.start, String(id), new Type("int"))];
	return check_access_function_node(target_type, target, node, status);
}

/**
 * `if id == N { self.#on_<event>_N(ref win) }` — one arm of the
 * synthesized `run_handler`.
 */
function up_call_arm(host: StructNode, event: string, id: number, start: number): IfElseNode {
	const condition = new OperationNode(
		start,
		"==",
		new ValueNode(start, "id", new Type("int")),
		new ValueNode(start, String(id), new Type("int")),
	);
	const dispatch = new AccessFunctionCallNode(start, `#${event}_${id}`);
	// `ref win` — the borrowed argument needs the same explicit `ref` a source
	// call site writes (ref_param_indices marks the keyword positions).
	dispatch.ref_param_indices = [0];
	dispatch.params = [new ValueNode(start, "win")];
	const call = new AccessNode(start, new ValueNode(start, "self", new Type(host.name)), dispatch);
	return new IfElseNode(start, condition, new BranchNode(start, [call]));
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
	const up_call_apps = pending_run_handlers.get(root);
	const event_dispatchers = pending_dispatchers.get(root);
	if (!hosts && !up_call_apps && !event_dispatchers) return;
	pending_hosts.delete(root);
	pending_dispatchers.delete(root);
	const host_set = new Set<StructNode>(hosts ?? []);
	const to_check: FunctionNode[] = [];
	for (const host of hosts ?? []) {
		const state = host_states.get(host)?.get("handle_clicks");
		if (state) to_check.push(state.func);
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
			for (const t of reachable_field_targets(field, status)) {
				if (reaches_host(t, stack)) {
					result = true;
					break;
				}
			}
			if (result) break;
		}
		stack.delete(s);
		reaches_memo.set(s, result);
		return result;
	};

	for (const s of status.structs) {
		const forwards: BaseNode[] = [];
		for (const f of s.fields) {
			const t = forwardable_field_type(f, status);
			if (t && reaches_host(t, new Set())) forwards.push(forward_statement(s, f.name));
		}
		// Dynamic trees (Stage 4): a host-typed LIST field dispatches per
		// element — the element borrow (`ref Row row = self.rows.at(i)`)
		// binds the slot, so the row's own arms run in place and their state
		// persists. Same children-first position as the static hops.
		for (const f of s.fields) {
			const elem = forwardable_list_element(f, status);
			if (elem && reaches_host(elem, new Set())) {
				forwards.push(...list_forward_loop(s, f.name, elem, status));
			}
		}
		if (forwards.length === 0) continue;
		// Who gets a dispatch body: App conformers (the run root drains them),
		// hosts (their arms), and structs an App reaches that lead further
		// down to a host (pure forwarders). Anything else is a dead chain.
		const is_app = s.traits.includes("App");
		const is_host = host_set.has(s);
		if (!is_app && !is_host && !reachable_from_an_app(s, status)) continue;
		let state = host_states.get(s)?.get("handle_clicks");
		if (!state) {
			// A pure forwarder (or an App conformer whose only handlers live
			// in its composites). A user-declared handle_clicks is left alone.
			if (s.functions.some((f) => f.name === "handle_clicks")) continue;
			const handle_clicks = new FunctionNode(-1, "pub", "handle_clicks", new Type(""), [
				ref_self_param(s),
				win_param(),
			]);
			s.functions.push(handle_clicks);
			state = { func: handle_clicks, next_index: new Map() };
			const click_map = host_states.get(s) ?? new Map<string, DispatcherState>();
			click_map.set("handle_clicks", state);
			host_states.set(s, click_map);
			to_check.push(handle_clicks);
		}
		// Children-first: forwarding splices ahead of the host's own arms.
		state.func.statements.unshift(...forwards);
	}

	for (const hc of to_check) {
		check_function_node(hc, status);
	}

	// The up-call protocol (Stage 3): check every synthesized `run_handler`
	// override the same way — all hoisted `#on_<event>_N` methods exist by
	// now, and the trait's default is declared on `App`.
	if (up_call_apps) {
		pending_run_handlers.delete(root);
		for (const app of up_call_apps) {
			const state = run_handler_states.get(app);
			if (!state) continue;
			check_function_node(state.run_handler, status);
		}
	}

	// The control-event dispatchers (focus/blur/input): check their bodies —
	// the prologue and arms are fully synthesized, and the App trait declares
	// the defaults they override.
	if (event_dispatchers) {
		pending_dispatchers.delete(root);
		for (const { host, dispatcher } of event_dispatchers) {
			const state = dispatcher_states.get(host)?.get(dispatcher);
			if (!state) continue;
			check_function_node(state.func, status);
		}
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

/**
 * The struct types a field makes REACHABLE for host-dispatch purposes: the
 * direct struct field target, plus (Stage 4) the element struct of a
 * `List<Row>` field — dynamic trees are dispatchable, so a composite type
 * hosted in a list is owned by the app exactly like a direct field.
 */
function reachable_field_targets(field: { type: Type }, status: CheckStatus): StructNode[] {
	const targets: StructNode[] = [];
	const direct = forwardable_field_type(field, status);
	if (direct) targets.push(direct);
	const elem = forwardable_list_element(field, status);
	if (elem) targets.push(elem);
	return targets;
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
		for (const t of reachable_field_targets(field, status)) {
			if (path_exists(t, target, status, stack)) return true;
		}
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

/**
 * The element struct a `List<Row>` field dispatches to, when the field is a
 * forwardable dynamic tree (either spelling of the mono). Containers of
 * trait/erased elements stay B5 territory — concrete rows only.
 */
function forwardable_list_element(
	field: { type: Type },
	status: CheckStatus,
): StructNode | undefined {
	const t = field.type;
	if (t.is_ref || t.is_view || t.is_array || t.is_nullable) return undefined;
	let elem_name: string | undefined;
	if (t.name === "List" && t.type_args?.length === 1) {
		elem_name = t.type_args[0].name;
	} else if (t.name.startsWith("List_")) {
		const mono = status.structs.find((s) => s.name === t.name && s.source_type_args?.length);
		elem_name = mono?.source_type_args?.[0]?.name;
	}
	if (!elem_name) return undefined;
	// The element must be a concrete registered struct (a row composite —
	// never a trait handle or a primitive).
	return status.structs.find((s) => s.name === elem_name && !s.is_generic);
}

/**
 * The dynamic-tree dispatch body for one `List<Row>` field (docs/HANDLERS.md
 * Stage 4):
 *
 * ```
 * var int _rows_i_N = 0
 * while _rows_i_N < self.rows.length; _rows_i_N += 1 {
 * 	ref Row _row = self.rows.at(_rows_i_N)
 * 	_row.handle_clicks(ref win)
 * }
 * ```
 *
 * The element borrow binds the SLOT (the checker rewrites `.at` to
 * `slot_ptr`), so each row's own arms run in place — state persists across
 * frames. The bounded-loop condition discharges `.at`'s bounds for the
 * borrow, and any list mutation (`ref self` on the list) invalidates the
 * borrow through the ordinary rules.
 */
function list_forward_loop(
	host: StructNode,
	field: string,
	elem: StructNode,
	status: CheckStatus,
): BaseNode[] {
	const start = -1;
	const index = `_${field}_i_${status.var_name_counter.value++}`;
	const index_value = (): ValueNode => new ValueNode(start, index, new Type("int"));
	const list_access = (): AccessNode =>
		new AccessNode(
			start,
			new ValueNode(start, "self", new Type(host.name)),
			new AccessFieldNode(start, field),
		);

	const declaration = new DeclarationNode(
		start,
		"private",
		"var",
		index,
		new Type("int"),
		new ValueNode(start, "0", new Type("int")),
	);

	const element_borrow = new DeclarationNode(
		start,
		"private",
		"ref",
		`_${field}_row`,
		new Type(elem.name),
		new AccessNode(
			start,
			list_access(),
			new AccessFunctionCallNode(start, "at", new Type(""), [index_value()]),
		),
	);
	// Ref-ness rides on `is_ref_binding` (the checker normalizes the
	// declaration keyword to `var` storage); the builds route the
	// value-struct alias through the element-borrow lowering on it.
	element_borrow.is_ref_binding = true;

	const dispatch = new AccessFunctionCallNode(start, "handle_clicks");
	// `ref win` — the borrowed argument needs the same explicit `ref` a source
	// call site writes (ref_param_indices marks the keyword positions).
	dispatch.ref_param_indices = [0];
	dispatch.params = [new ValueNode(start, "win")];
	const call = new AccessNode(
		start,
		new ValueNode(start, `_${field}_row`, new Type(elem.name)),
		dispatch,
	);

	const condition = new OperationNode(
		start,
		"<",
		index_value(),
		new AccessNode(start, list_access(), new AccessFieldNode(start, "length")),
	);
	const update = new AssignmentNode(
		start,
		index_value(),
		new ValueNode(start, "1", new Type("int")),
		"+=",
	);
	return [declaration, new WhileLoopNode(start, condition, [element_borrow, call], update)];
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
 * The event-source arming prologue (click family only: the recognizer/
 * target init — idempotent per handle). Other events poll passively and
 * have no arming.
 */
function arm_init_statement(
	drain_arm: string,
	receiver: BaseNode,
	start: number,
): FunctionCallNode {
	const handle = new AccessNode(start, receiver, new AccessFieldNode(start, "handle"));
	return new FunctionCallNode(start, drain_arm, new Type(""), [handle]);
}

/**
 * `if <drain>(self.<path>.handle) { self.<hidden>(ref win) }` — one arm of
 * the synthesized dispatcher.
 */
function arm_dispatch_statement(
	host: StructNode,
	fields: string[],
	drain: string,
	hidden: string,
	start: number,
): IfElseNode {
	const receiver = arm_receiver(host, fields, start);
	const handle = new AccessNode(start, receiver, new AccessFieldNode(start, "handle"));
	const condition = new FunctionCallNode(start, drain, new Type("bool"), [handle]);
	const dispatch = new AccessFunctionCallNode(start, hidden);
	// `ref win` — the borrowed argument needs the same explicit `ref` a source
	// call site writes (ref_param_indices marks the keyword positions).
	dispatch.ref_param_indices = [0];
	dispatch.params = [new ValueNode(start, "win")];
	const call = new AccessNode(start, new ValueNode(start, "self", new Type(host.name)), dispatch);
	return new IfElseNode(start, condition, new BranchNode(start, [call]));
}
