import add_error from "../../add_error.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import AssignmentNode from "../../nodes/AssignmentNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import BranchNode from "../../nodes/BranchNode.ts";
import DeclarationNode from "../../nodes/DeclarationNode.ts";
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
 * synthesized `handle_events` method:
 *
 * ```
 * func handle_events = (ref self, ref Window win) {
 * 	nomen_window_clicks_init(self.<field>.handle)
 * 	if self.<field>.take_click() { self.#on_click_N(ref win) }
 * }
 * ```
 *
 * `App` declares a default-empty `handle_events`; `Window.run` calls
 * `app.handle_events(ref win)` before `frame`, so the borrow of `self` is
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

/** The one pump slot's name on handler hosts. */
const PUMP_NAME = "handle_events";

/** The pumps awaiting their final check, per compile root. */
interface DispatcherState {
	/** The synthesized pump, appended to the host's functions. */
	func: FunctionNode;
	/** Per-event hidden-method counters (registration order drives arms). */
	next_index: Map<string, number>;
}

/**
 * Per-check synthesis state, keyed by the host struct (one pump per host).
 * Module-level (not on CheckStatus) because `clone_status` copies a fixed
 * field list — state recorded inside a branch clone (a registration nested
 * in an `if`) must survive the clone's discard. The per-check entry in
 * `pending_pumps` dies with the check that created it: `finalize` deletes by
 * root identity, and an aborted compile (parse errors, no check pass) never
 * creates an entry.
 */
const dispatcher_states = new WeakMap<StructNode, DispatcherState>();

/** Hosts whose pump awaits its final check, per compile root. */
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
 * Per-app tick-forward state (Stage 3): one entry per enrolled composite
 * field path, recorded at the registration site and turned into pump
 * statements at finalize — `self.<fields>.tick(ref self, ref win)` — so the
 * app never writes the owner-forwarding call by hand.
 */
interface TickState {
	/** Enrolled field paths, in registration order, deduped per app. */
	entries: Array<{ fields: string[]; composite: StructNode }>;
	/** The dedupe keys (one tick per field path, however many events). */
	seen: Set<string>;
}

/** Per-app tick-forward state (see host_states for why module-level). */
const tick_states = new WeakMap<StructNode, TickState>();

/** Apps whose pump awaits its synthesized tick forwards (see pending_hosts). */
const pending_tick_apps = new Map<BaseNode, StructNode[]>();

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

	// Event routing, in precedence order:
	//
	// 1. DECLARED EVENT API (Stage 3) — the receiver declares
	//    `func on_<event> = (ref self, int id)`: the widget owns the event
	//    source and drains it (its tick up-calls `run_handler`), and the
	//    desugar routes the registration through the enrollment rewrite.
	//    This is the framework-author extension point — any widget, any
	//    event name, GUI or not (a voice-only widget's `on_command`), and
	//    `on_click` itself. A declared API wins over the builtin table.
	// 2. CONTROL DRAIN (naming convention, no table) — `on_<event>` routes
	//    to the control's own `take_<event>` drain method (Button.take_click,
	//    TextBox.take_input, …): the control DECLARES which events it emits,
	//    in the library, next to its native plumbing. No compiler table, no
	//    privileged events; a new event kind is new library methods.
	// 3. Otherwise — ordinary resolution ("Function not found" for a missing
	//    member; a same-named method on a non-control resolves as a call).
	const composite = try_check_composite_event(receiver, target_type, target, node, status, fail);
	if (composite !== undefined) return composite;

	return try_check_control_drain(receiver, target_type, target, node, status, fail);
}

/**
 * The control-carried event path (docs/HANDLERS.md, "Registered control
 * events"): the event comes from the CONTROL's own source (the click ring,
 * the window's first responder, the control's text), the synthesized arm
 * polls that source's drain primitive, and the hidden method hoists onto
 * the App conformer the way the click desugar does. Config comes from
 * and everything here is event-agnostic.
 */
function try_check_control_drain(
	receiver: StructNode,
	target_type: Type,
	target: BaseNode,
	node: AccessFunctionCallNode,
	status: CheckStatus,
	fail: (message: string) => false,
): boolean {
	// The drain is the control's own take_<event> method (naming convention,
	// no compiler table): on_click → take_click, on_input → take_input.
	const drain = `take_${node.name.slice(3)}`;
	if (!receiver.functions.some((f) => f.name === drain && f.params.length === 1)) {
		// The control doesn't emit this event — a named, per-control error
		// (the event vocabulary is the control's own declared API).
		return fail(`'${receiver.name}' doesn't emit ${node.name} events (no ${drain} drain)`);
	}
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

	// The pump (per host): get or synthesize. A USER-declared same-named
	// method would collide with the synthesized pump (the name is reserved on
	// hosts with registrations). Past this point a same-named method is our
	// own synthesis from an earlier registration.
	let state = dispatcher_states.get(host);
	if (!state) {
		if (host.functions.some((f) => f.name === PUMP_NAME)) {
			return fail(
				`'${host.name}' already declares ${PUMP_NAME} — the .${node.name} desugar synthesizes it (the name is reserved on handler hosts)`,
			);
		}
		const func = new FunctionNode(node.start, "pub", PUMP_NAME, new Type(""), [
			ref_self_param(host),
			win_param(),
		]);
		host.functions.push(func);
		state = { func, next_index: new Map() };
		dispatcher_states.set(host, state);
		const root = status.stack[0];
		let hosts = pending_hosts.get(root);
		if (!hosts) {
			hosts = [];
			pending_hosts.set(root, hosts);
		}
		hosts.push(host);
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
	// poll.) The drain is the control's own take_<event> method — arming and
	// native plumbing live inside it, on the control.
	state.func.statements.push(arm_dispatch_statement(host, fields, drain, hidden, node.start));

	// The registration site emits no code at all.
	node.is_handler_registration = true;
	node.type = new Type("");
	return true;
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
 *    id (the one thing tier 2 stores: an int, never a handler);
 *  - the app's dispatch pump gains the per-frame owner forward
 *    `self.<fields>.tick(ref self, ref win)` at finalize — registration is
 *    register-and-forget, the app never writes the forwarding call.
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
		`#up_${node.name}_${id}`,
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

	// ── The tick forward ── recorded here, appended to the app's dispatch
	// pump at finalize (after the forwards and own arms: the tick delivers
	// the owner down to composites whose arms just ran this frame). One
	// tick per field path, however many events are enrolled on it.
	let ticks = tick_states.get(host);
	if (!ticks) {
		ticks = { entries: [], seen: new Set() };
		tick_states.set(host, ticks);
		const tick_root = status.stack[0];
		let apps = pending_tick_apps.get(tick_root);
		if (!apps) {
			apps = [];
			pending_tick_apps.set(tick_root, apps);
		}
		apps.push(host);
	}
	const path_key = fields.join(".");
	if (!ticks.seen.has(path_key)) {
		ticks.seen.add(path_key);
		ticks.entries.push({ fields, composite: receiver });
	}

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
	const dispatch = new AccessFunctionCallNode(start, `#up_${event}_${id}`);
	// `ref win` — the borrowed argument needs the same explicit `ref` a source
	// call site writes (ref_param_indices marks the keyword positions).
	dispatch.ref_param_indices = [0];
	dispatch.params = [new ValueNode(start, "win")];
	const call = new AccessNode(start, new ValueNode(start, "self", new Type(host.name)), dispatch);
	return new IfElseNode(start, condition, new BranchNode(start, [call]));
}

/**
 * Check every host's synthesized `handle_events`, after first synthesizing
 * the FORWARDING wiring (Stage 2, HANDLERS.md "Handler hosts beyond the
 * root"): a struct with registrations is a handler host — not just the App.
 * Dispatch reaches non-root hosts down static field paths: every struct on a
 * path from an App conformer to a host gets a `handle_events` (its own arms
 * if it registers, pure forwarding if it doesn't) that forwards to each
 * host-reaching field — `self.<field>.handle_events(ref win)` — direct
 * calls, no trait objects. Dispatch order is children-first, then own arms
 * (most specific first, HANDLERS.md "user-authored composites").
 *
 * Runs once, after the whole tree has been checked: the arms reference the
 * hidden `#on_click_N` methods (checked at their registration sites), the
 * drain methods (`take_click` et al) and the `Window` type are resolved, and
 * the full field graph (gathered upfront) decides reachability. Checking the
 * bodies also stamps every node for the build.
 */
export function finalize_handler_hosts(status: CheckStatus): void {
	const root = status.stack[0];
	const hosts = pending_hosts.get(root);
	const up_call_apps = pending_run_handlers.get(root);
	const tick_apps = pending_tick_apps.get(root);
	if (!hosts && !up_call_apps && !tick_apps) return;
	pending_hosts.delete(root);
	pending_tick_apps.delete(root);
	const host_set = new Set<StructNode>(hosts ?? []);
	const to_check: FunctionNode[] = [];
	for (const host of hosts ?? []) {
		const state = dispatcher_states.get(host);
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
		let state = dispatcher_states.get(s);
		if (!state) {
			// A pure forwarder (or an App conformer whose only handlers live
			// in its composites). A user-declared pump is left alone.
			if (s.functions.some((f) => f.name === PUMP_NAME)) continue;
			const pump = new FunctionNode(-1, "pub", PUMP_NAME, new Type(""), [
				ref_self_param(s),
				win_param(),
			]);
			s.functions.push(pump);
			state = { func: pump, next_index: new Map() };
			dispatcher_states.set(s, state);
			to_check.push(pump);
		}
		// Children-first: forwarding splices ahead of the host's own arms.
		state.func.statements.unshift(...forwards);
	}

	// The tick-forward pass (Stage 3): every app with composite enrollments
	// gets `self.<field>.tick(ref self, ref win)` appended to its pump —
	// after the forwards (children-first) and the own arms, because the
	// tick delivers the owner down to composites whose arms just ran this
	// frame. The pump may not exist yet (a composite with no internal
	// handlers is not a host, so the forwarding pass skipped the app):
	// create it the same way. A user-declared pump is left alone (its
	// author owns the forwarding, as before this synthesis existed).
	for (const app of tick_apps ?? []) {
		const ticks = tick_states.get(app);
		if (!ticks) continue;
		let state = dispatcher_states.get(app);
		if (!state) {
			if (app.functions.some((f) => f.name === PUMP_NAME)) continue;
			const pump = new FunctionNode(-1, "pub", PUMP_NAME, new Type(""), [
				ref_self_param(app),
				win_param(),
			]);
			app.functions.push(pump);
			state = { func: pump, next_index: new Map() };
			dispatcher_states.set(app, state);
			to_check.push(pump);
		}
		for (const entry of ticks.entries) {
			// The composite's side of the protocol is a `tick = (ref self,
			// <owner>, ref Window win)` method; without it there is nothing
			// to forward (and no up-call could ever fire anyway).
			const has_tick = entry.composite.functions.some(
				(f) => f.name === "tick" && f.params.length === 3 && f.params[0].is_self_param,
			);
			if (!has_tick) continue;
			const tick_call = new AccessFunctionCallNode(-1, "tick");
			// `ref self` (the owner borrow flowing down) and `ref win` —
			// both need the explicit `ref` a source call site writes.
			tick_call.ref_param_indices = [0, 1];
			tick_call.params = [new ValueNode(-1, "self", new Type(app.name)), new ValueNode(-1, "win")];
			state.func.statements.push(
				new AccessNode(-1, arm_receiver(app, entry.fields, -1), tick_call),
			);
		}
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

/** `self.<field>.handle_events(ref win)` — one hop down the ownership path. */
function forward_statement(host: StructNode, field: string): AccessNode {
	const receiver = new AccessNode(
		-1,
		new ValueNode(-1, "self", new Type(host.name)),
		new AccessFieldNode(-1, field),
	);
	const dispatch = new AccessFunctionCallNode(-1, "handle_events");
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
 * 	_row.handle_events(ref win)
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

	const dispatch = new AccessFunctionCallNode(start, "handle_events");
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
	const condition = new AccessFunctionCallNode(start, drain);
	const condition_call = new AccessNode(start, arm_receiver(host, fields, start), condition);
	const dispatch = new AccessFunctionCallNode(start, hidden);
	// `ref win` — the borrowed argument needs the same explicit `ref` a source
	// call site writes (ref_param_indices marks the keyword positions).
	dispatch.ref_param_indices = [0];
	dispatch.params = [new ValueNode(start, "win")];
	const call = new AccessNode(start, new ValueNode(start, "self", new Type(host.name)), dispatch);
	return new IfElseNode(start, condition_call, new BranchNode(start, [call]));
}
