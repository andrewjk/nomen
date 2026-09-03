/**
 * Structured model for lifted AArch64 assembly (see lift_asm.ts). Phase 1
 * uses this for validation only — every parsed line keeps its original text,
 * so re-emission is byte-identical by construction. Later phases transform
 * the structured form.
 */

export type Operand =
	| { kind: "reg"; name: string; cls: "gpr" | "fpr"; width: 32 | 64 | 128 }
	| { kind: "imm"; value: bigint; raw: string }
	| { kind: "label"; name: string }
	| { kind: "cond"; code: string }
	| {
			kind: "mem";
			base: string;
			offset?: { kind: "imm"; value: bigint } | { kind: "reg"; name: string };
			scale?: number;
			writeback?: "pre" | "post";
			postOffset?: bigint;
	  };

export interface AsmInstruction {
	/** Original line text — re-emission echoes this verbatim. */
	text: string;
	line: number;
	op: string;
	operands: Operand[];
	setsFlags: boolean;
	readsFlags: boolean;
}

export interface AsmLabel {
	kind: "label";
	name: string;
	text: string;
	line: number;
}

export interface AsmDirective {
	kind: "directive";
	text: string;
	line: number;
}

export type AsmLine = AsmInstruction | AsmLabel | AsmDirective;

export interface LiftedFunction {
	name: string;
	body: AsmLine[];
}

export interface LiftError {
	message: string;
	line: number;
	text: string;
}

// Registers accepted in general-purpose positions. fp/lr are aliases the
// emitters may use; they normalize to x29/x30.
const GPR64 = new Set(["sp", "xzr", "wzr", "fp", "lr"]);
for (let i = 0; i <= 30; i++) {
	GPR64.add(`x${i}`);
	GPR64.add(`w${i}`);
}

const FPR = new Set<string>();
for (let i = 0; i <= 31; i++) {
	FPR.add(`d${i}`);
	FPR.add(`s${i}`);
	FPR.add(`q${i}`);
	// v16-v31: the expression-tree pool (low halves alias d16-d31).
	if (i >= 16) FPR.add(`v${i}`);
}

/**
 * Vector operand forms the NEON lowering emits: an arrangement-suffixed
 * register (`v0.2d`, `v1.16b`) or a lane accessor (`v0.d[0]`). They classify
 * as FPRs (width 128) — the arrangement/lane suffix carries no validation
 * semantics the lift needs, only the register does.
 */
const VECTOR_FORM_RE = /^[vq]\d+\.(16b|8b|2d|1d|2s|4s|[ds]\[\d+\])$/;

export function is_gpr(name: string): boolean {
	return GPR64.has(name);
}

export function is_fpr(name: string): boolean {
	return FPR.has(name) || VECTOR_FORM_RE.test(name);
}

export function reg_class(name: string): "gpr" | "fpr" | null {
	if (is_gpr(name)) return "gpr";
	if (is_fpr(name)) return "fpr";
	return null;
}

/** Condition codes usable after `cmp` (integer) — the superset the emitters
 *  produce; `mi`/`pl` are produced by the fcmp lowering. */
const COND_CODES = new Set([
	"eq",
	"ne",
	"gt",
	"ge",
	"lt",
	"le",
	"hi",
	"hs",
	"lo",
	"ls",
	"mi",
	"pl",
]);

export function is_cond(code: string): boolean {
	return COND_CODES.has(code);
}

/**
 * Per-position operand classes for each mnemonic signature.
 *   r = general-purpose register   f = FP register   i = immediate
 *   c = condition code             l = label         m = memory operand
 *   x = used in a cross-class bit-cast position (fmov/scvtf/fcvtzs)
 */
type Pos = "r" | "f" | "i" | "c" | "l" | "m";

interface MnemonicSig {
	shapes: Pos[][];
	setsFlags?: boolean;
	readsFlags?: boolean;
}

/**
 * Signatures for every mnemonic the backend emits (surveyed across
 * src/build_aarch64 templates and core/System raw `#arch: aarch64` blocks).
 * Anything not listed fails the lift — new emissions must be added here,
 * which is the point: the table is the contract.
 */
export const MNEMONICS: Record<string, MnemonicSig> = {
	mov: {
		shapes: [
			["r", "r"],
			["r", "i"],
			["f", "f"], // vector mov (`mov v0.16b, v4.16b`)
		],
	},
	bic: { shapes: [["r", "r", "i"]] },
	dup: {
		shapes: [
			["f", "f"], // dup v0.2d, v0.d[0] (lane splat)
			["f", "r"], // dup v0.2d, x0 / dup v0.4s, w0 (gpr splat)
		],
	},
	movz: { shapes: [["r", "i"]] },
	mvn: { shapes: [["r", "r"]] },
	fmov: {
		shapes: [
			["f", "f"],
			["f", "r"],
			["r", "f"],
		],
	},
	add: {
		shapes: [
			["r", "r", "r"],
			["r", "r", "i"],
			["f", "f", "f"], // vector `add v0.2d/4s, …`
			["r", "r", "l"], // `add x9, x9, _sym@PAGEOFF` (adrp pair idiom)
		],
	},
	sub: {
		shapes: [
			["r", "r", "r"],
			["r", "r", "i"],
			["f", "f", "f"], // vector `sub v0.2d/4s, …`
		],
	},
	// Flag-setting add/sub (tranche J): the declare-side arithmetic whose
	// carry/borrow a fused cset/cinc reads. cs == hs, cc == lo (aliases).
	adds: {
		shapes: [
			["r", "r", "r"],
			["r", "r", "i"],
		],
		setsFlags: true,
	},
	subs: {
		shapes: [
			["r", "r", "r"],
			["r", "r", "i"],
		],
		setsFlags: true,
	},
	// Conditional increment: `cinc xN, xN, cc` = xN + 1 when cond — the
	// register-home `x += 1` tail of the fused carry compare.
	cinc: { shapes: [["r", "r", "c"]], readsFlags: true },
	and: {
		shapes: [
			["r", "r", "r"],
			["r", "r", "i"],
			["f", "f", "f"], // vector `and v0.16b, …`
		],
	},
	orr: {
		shapes: [
			["r", "r", "r"],
			["r", "r", "i"],
			["f", "f", "f"], // vector `orr v0.16b, …`
		],
	},
	eor: {
		shapes: [
			["r", "r", "r"],
			["r", "r", "i"],
			["f", "f", "f"], // vector `eor v0.16b, …`
		],
	},
	mul: {
		shapes: [
			["r", "r", "r"],
			["f", "f", "f"], // vector `mul v0.2d/4s, …`
		],
	},
	madd: { shapes: [["r", "r", "r", "r"]] },
	msub: { shapes: [["r", "r", "r", "r"]] },
	sdiv: { shapes: [["r", "r", "r"]] },
	udiv: { shapes: [["r", "r", "r"]] },
	lsl: {
		shapes: [
			["r", "r", "i"],
			["r", "r", "r"],
		],
	},
	asr: {
		shapes: [
			["r", "r", "i"],
			["r", "r", "r"],
		],
	},
	lsr: {
		shapes: [
			["r", "r", "i"],
			["r", "r", "r"],
		],
	},
	neg: { shapes: [["r", "r"]] },
	fneg: { shapes: [["f", "f"]] },
	fadd: { shapes: [["f", "f", "f"]] },
	fsub: { shapes: [["f", "f", "f"]] },
	fmul: { shapes: [["f", "f", "f"]] },
	fdiv: { shapes: [["f", "f", "f"]] },
	// FMA contraction family (fast_math): fused multiply-add forms —
	// fmadd d0, n, m, a = n*m + a; fmsub = n*m - a; fnmadd = -(n*m) + a;
	// fnmsub = -(n*m) - a. Vector accumulate forms: fmla vd, vn, vm
	// (vd += vn*vm) and fmls (vd -= vn*vm).
	fmadd: { shapes: [["f", "f", "f", "f"]] },
	fmsub: { shapes: [["f", "f", "f", "f"]] },
	fnmadd: { shapes: [["f", "f", "f", "f"]] },
	fnmsub: { shapes: [["f", "f", "f", "f"]] },
	fmla: { shapes: [["f", "f", "f"]] },
	fmls: { shapes: [["f", "f", "f"]] },
	// FADDP (scalar): horizontal pair-add — `faddp d0, v2.2d` (the NEON
	// reduction's 2-lane float combine).
	faddp: { shapes: [["f", "f"]] },
	// ADDP (scalar) / ADDV (add-across): the integer `+` reduction's
	// horizontal combines — wrap-exact under any association.
	addp: { shapes: [["f", "f"]] },
	addv: { shapes: [["f", "f"]] },
	fcmp: { shapes: [["f", "f"]], setsFlags: true },
	fsqrt: { shapes: [["f", "f"]] },
	// SCVTF: integer→float. Both forms are emitted: x-source (scvtf d0, x0)
	// and the in-place d-source bit-form (fmov d0, x0; scvtf d0, d0).
	scvtf: {
		shapes: [
			["f", "r"],
			["f", "f"],
		],
	},
	fcvtzs: { shapes: [["r", "f"]] },
	cmp: {
		shapes: [
			["r", "r"],
			["r", "i"],
		],
		setsFlags: true,
	},
	tst: {
		shapes: [
			["r", "r"],
			["r", "i"],
		],
		setsFlags: true,
	},
	cmn: {
		shapes: [
			["r", "r"],
			["r", "i"],
		],
		setsFlags: true,
	},
	cset: { shapes: [["r", "c"]], readsFlags: true },
	csel: { shapes: [["r", "r", "r", "c"]], readsFlags: true },
	ldr: {
		shapes: [
			["r", "m"],
			["f", "m"],
			["r", "i"], // `ldr x0, =imm64` load-literal pseudo-form
		],
	},
	str: {
		shapes: [
			["r", "m"],
			["f", "m"],
		],
	},
	ldrb: { shapes: [["r", "m"]] },
	strb: { shapes: [["r", "m"]] },
	ldrh: { shapes: [["r", "m"]] },
	strh: { shapes: [["r", "m"]] },
	ldrsb: { shapes: [["r", "m"]] },
	ldrsh: { shapes: [["r", "m"]] },
	ldrsw: { shapes: [["r", "m"]] },
	ldp: {
		shapes: [
			["r", "r", "m"],
			["f", "f", "m"],
		],
	},
	stp: {
		shapes: [
			["r", "r", "m"],
			["f", "f", "m"],
		],
	},
	adr: { shapes: [["r", "l"]] },
	// adrp: page-relative symbol address (Mach-O `adrp x9, _sym@PAGE`). The
	// vtable install in every trait-conforming struct's init uses adrp+add
	// because the vtable lives in the __DATA segment (cross-section from
	// __TEXT, so adr's ±1MB reach doesn't apply).
	adrp: { shapes: [["r", "l"]] },
	b: { shapes: [["l"]] },
	cbz: { shapes: [["r", "l"]] },
	cbnz: { shapes: [["r", "l"]] },
	tbz: { shapes: [["r", "l", "i"]] },
	tbnz: { shapes: [["r", "l", "i"]] },
	bl: { shapes: [["l"]] },
	blr: { shapes: [["r"]] },
	ret: { shapes: [[]] },
	svc: { shapes: [["i"]] },
};

for (const cond of COND_CODES) {
	MNEMONICS[`b.${cond}`] = { shapes: [["l"]], readsFlags: true };
	// ARM32-style aliases some raw library blocks use (blt/beq/…). The
	// integrated assembler accepts them; the lift normalizes the class.
	MNEMONICS[`b${cond}`] = { shapes: [["l"]], readsFlags: true };
}
