#!/usr/bin/env bash
# Build + time the Nomen benchmarks on the C backend (and optionally aarch64),
# best-of-N. Usage: bench/ab.sh <c|aarch64> [bench names...]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT/cli/node_modules/.bin/tsx"
[ -x "$TSX" ] || TSX="$ROOT/node_modules/.bin/tsx"
ARCH="${1:-c}"
shift || true
BENCHES=("$@")
if [ ${#BENCHES[@]} -eq 0 ]; then
	BENCHES=(nsieve knucleotide json-serde pidigits binarytrees lru regex-redux)
fi
OUT="${TMPDIR:-/tmp}/nomen_ab_$$"
mkdir -p "$OUT"
for b in "${BENCHES[@]}"; do
	src="$ROOT/bench/nomen/$b.nm"
	[ -f "$src" ] || { echo "missing $src"; continue; }
	bin="$OUT/$b"
	if ! "$TSX" "$ROOT/bench/compile_nomen.ts" "$src" "$bin" "$ROOT/core" "$ARCH" >/dev/null 2>"$OUT/$b.err"; then
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
