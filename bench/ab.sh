#!/usr/bin/env bash
# Build + time the Nomen benchmarks on the C backend (and optionally aarch64),
# best-of-N. Usage: bench/ab.sh <c|aarch64> [bench names...]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ESBUILD="$ROOT/node_modules/.bin/esbuild"
ARCH="${1:-c}"
shift || true
BENCHES=("$@")
if [ ${#BENCHES[@]} -eq 0 ]; then
	BENCHES=(nsieve knucleotide json-serde pidigits binarytrees lru regex-redux)
fi
OUT="${TMPDIR:-/tmp}/nomen_ab_$$"
mkdir -p "$OUT"

# Bundle the compiler ONCE, untimed — the benchmark.sh warm-up treatment. The
# old tsx invocation re-transpiled the compiler's ~140k lines of TypeScript
# on every benchmark compile; the bundled runner is the same entry point on a
# prebuilt artifact (correctness tool or not, iteration is the point here).
NOMEN_RUNNER="$OUT/compile_nomen.mjs"
"$ESBUILD" "$ROOT/bench/compile_nomen.ts" \
	--bundle --platform=node --format=esm \
	--outfile="$NOMEN_RUNNER" --log-level=error

for b in "${BENCHES[@]}"; do
	src="$ROOT/bench/nomen/$b.nm"
	[ -f "$src" ] || { echo "missing $src"; continue; }
	bin="$OUT/$b"
	if ! node "$NOMEN_RUNNER" "$src" "$bin" "$ROOT/core" "$ARCH" >/dev/null 2>"$OUT/$b.err"; then
		echo "$b: COMPILE FAILED"
		head -5 "$OUT/$b.err"
		continue
	fi
	# "large" workload args per benchmark.sh's BENCHES table
	case "$b" in
		pidigits) args="4000" ;;
		binarytrees) args="18" ;;
		nsieve) args="12" ;;
		lru) args="100 200000" ;;
		knucleotide) args="$ROOT/bench/knucleotide_input.txt" ;;
		json-serde) args="$ROOT/bench/sample.json 5000" ;;
		regex-redux) args="$ROOT/bench/25000_in" ;;
		fannkuch-redux) args="12" ;;
		nbody) args="5000000" ;;
		spectral-norm) args="3200" ;;
		mandelbrot) args="1600" ;;
		edigits) args="10000" ;;
		merkletrees) args="16" ;;
		*) args="" ;;
	esac
	best=9999
	for i in 1 2 3 4 5; do
		s=$( { /usr/bin/time -p "$bin" $args >/dev/null; } 2>&1 | awk '/^real/ {print $2}')
		[ -n "$s" ] && best=$(python3 -c "print(min($best, $s))")
	done
	echo "$b ($ARCH): ${best}s"
done
rm -rf "$OUT"
