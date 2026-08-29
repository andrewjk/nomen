import { execSync } from "node:child_process";
function time(cmd: string): number {
	const t0 = performance.now();
	execSync(cmd);
	return performance.now() - t0;
}
function med(a: number[]): number {
	return [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
}
const benches: [string, string, string][] = [
	["mandelbrot", "/tmp/ABB_mandelbrot", "/tmp/ABB2_mandelbrot"],
	["spectral-norm", "/tmp/ABB_spectral-norm", "/tmp/ABB2_spectral-norm"],
	["nbody", "/tmp/ABB_nbody", "/tmp/ABB2_nbody"],
	["fannkuch-redux", "/tmp/ABB_fannkuch-redux", "/tmp/ABB2_fannkuch-redux"],
];
const args: Record<string, string> = {
	mandelbrot: "1000",
	"spectral-norm": "1000",
	nbody: "1000000",
	"fannkuch-redux": "9",
};
for (const [name, olddir, newdir] of benches) {
	const co = `${olddir}/bin ${args[name]}`;
	const cn = `${newdir}/bin ${args[name]}`;
	const oo = execSync(co).toString().trim().split("\n")[0];
	const on = execSync(cn).toString().trim().split("\n")[0];
	time(co);
	time(cn);
	const ro: number[] = [],
		rn: number[] = [];
	for (let r = 0; r < 7; r++) {
		ro.push(time(co));
		rn.push(time(cn));
	}
	console.log(
		`${name.padEnd(14)} before ${med(ro).toFixed(0).padStart(5)}ms → after ${med(rn).toFixed(0).padStart(5)}ms (${(((med(rn) - med(ro)) / med(ro)) * 100).toFixed(0)}%)  out ${oo === on ? "match" : `DIFFER "${oo}" vs "${on}"`}`,
	);
}
