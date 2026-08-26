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
}

export function is_gpr(name: string): boolean {
	return GPR64.has(name);
}

export function is_fpr(name: string): boolean {
	return FPR.has(name);
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
		],
	},
	sub: {
		shapes: [
			["r", "r", "r"],
			["r", "r", "i"],
		],
	},
	and: {
		shapes: [
			["r", "r", "r"],
			["r", "r", "i"],
		],
	},
	orr: {
		shapes: [
			["r", "r", "r"],
			["r", "r", "i"],
		],
	},
	eor: {
		shapes: [
			["r", "r", "r"],
			["r", "r", "i"],
		],
	},
	mul: { shapes: [["r", "r", "r"]] },
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
	fcmp: { shapes: [["f", "f"]], setsFlags: true },
	fsqrt: { shapes: [["f", "f"]] },
	scvtf: { shapes: [["f", "r"]] },
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
