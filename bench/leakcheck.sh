#!/usr/bin/env bash
set -euo pipefail

# Independent leak verification of the Nomen benchmark programs.
#
# valgrind does not support macOS/ARM64, so this uses the built-in macOS
# `leaks` tool instead: each program runs under MallocStackLogging with
# `leaks -atExit`, which reports allocated-but-unreachable memory at exit
# — the same leak class valgrind calls "definitely lost". No Nomen code is
# involved, so this is an independent check alongside the compiler's
# `--audit` runtime. Both codegen backends are verified (aarch64 and C).
#
# Before trusting any results, a deliberately leaking probe program is run;
# if the detector fails to flag it (e.g. MallocStackLogging unavailable),
# the script aborts rather than printing vacuous "0 leaks" rows.
#
# Note: like valgrind's "definitely lost", `leaks` does not flag memory that
# is still reachable at exit (e.g. held by a global). `--audit` remains the
# stricter balanced-counter check; the two complement each other.
#
# Usage:
#   bench/leakcheck.sh                    # all benches, both backends, small args
#   bench/leakcheck.sh pidigits nbody     # subset by name
#   bench/leakcheck.sh --large            # also run the large workload size
#   bench/leakcheck.sh --release 0        # unoptimized builds (different codegen)
#   bench/leakcheck.sh --keep             # keep the temp build dir
#
# Exit status is nonzero if any bench leaks, crashes, or fails to build.
# The temp build dir is removed on success and kept (path printed) on failure.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_DIR="$ROOT/bench"
TSX="$ROOT/cli/node_modules/.bin/tsx"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/nomen_leakcheck_XXXXXX")"
LOG="$WORK/last.log"

KEEP=0
LARGE=0
RELEASE=1
SELECTED=()

while [ $# -gt 0 ]; do
	case "$1" in
	--large) LARGE=1 ;;
	--keep) KEEP=1 ;;
	--release) RELEASE="${2:?--release needs 0 or 1}" ;;
	--release=*) RELEASE="${1#*=}" ;;
	-*) echo "unknown option: $1" >&2; exit 2 ;;
	*) SELECTED+=("$1") ;;
	esac
	shift
done

cleanup() {
	if [ "$KEEP" = 0 ]; then
		rm -rf "$WORK"
	fi
}
trap cleanup EXIT

# ── Benchmark definitions ────────────────────────────────────────────────────
# Same programs and workload sizes as benchmark.sh. Format: name|small_args|large_args
# `$BENCH_DIR` in args expands at use time.

BENCHES=(
	"pidigits|1000|4000"
	"helloworld|0|0"
	"fannkuch-redux|10|11"
	"binarytrees|15|18"
	"merkletrees|15|17"
	"nsieve|10|12"
	"lru|100 50000|100 200000"
	"knucleotide|$BENCH_DIR/knucleotide_input.txt|$BENCH_DIR/knucleotide_input.txt"
	"json-serde|$BENCH_DIR/sample.json 1000|$BENCH_DIR/sample.json 5000"
	"regex-redux|$BENCH_DIR/25000_in|$BENCH_DIR/25000_in"
	"nbody|500000|5000000"
	"spectral-norm|500|1500"
	"mandelbrot|1000|2000"
	"edigits|2000|5000"
)

# ── Detector sanity check ────────────────────────────────────────────────────
# The last allocation's pointer may stay register-rooted at exit, so 16
# dropped allocations should still yield >= 1 reported leaks.

cat >"$WORK/leaky.c" <<'EOF'
#include <stdlib.h>
int main(void) {
	for (int i = 0; i < 16; i++) {
		char *a = malloc(1234);
		a[0] = 1;
	}
	return 0;
}
EOF

if ! clang "$WORK/leaky.c" -o "$WORK/leaky" 2>"$WORK/leaky.log"; then
	echo "FAIL: could not compile the leak probe" >&2
	cat "$WORK/leaky.log" >&2
	exit 1
fi

MallocStackLogging=1 leaks -atExit -- "$WORK/leaky" >"$WORK/leaky.log" 2>&1 || true
probe=$(grep "leaks for" "$WORK/leaky.log" | tail -1 | sed -E 's/^Process [0-9]+: ([0-9]+) leaks.*/\1/')
if [ -z "$probe" ] || [ "$probe" -eq 0 ]; then
	echo "FAIL: leak detector did not flag the probe program (reported: '${probe:-nothing}')." >&2
	echo "MallocStackLogging is likely unavailable; results would be meaningless." >&2
	exit 1
fi
echo "leak detector verified: probe program flagged ($probe leaked allocation(s))"
echo ""

# ── Helpers ──────────────────────────────────────────────────────────────────

# selected <name>: true when no name filter was given or name is in SELECTED.
selected() {
	local name="$1" s
	[ "${#SELECTED[@]}" -eq 0 ] && return 0
	for s in "${SELECTED[@]}"; do
		[ "$s" = "$name" ] && return 0
	done
	return 1
}

# leak_cell <binary> <args...>: run under the leak detector and print the
# table cell. Increments FAILURES on any bad outcome.
FAILURES=0
leak_cell() {
	local bin="$1"
	shift
	local rc=0 line count bytes
	if [ ! -x "$bin" ]; then
		FAILURES=$((FAILURES + 1))
		printf "%-16s" "BUILD FAILED"
		return
	fi
	MallocStackLogging=1 leaks -atExit -- "$bin" "$@" >"$LOG" 2>&1 || rc=$?
	line=$(grep "leaks for" "$LOG" | tail -1)
	count=$(printf '%s' "$line" | sed -E 's/^Process [0-9]+: ([0-9]+) leaks.*/\1/')
	bytes=$(printf '%s' "$line" | sed -E 's/.*leaks for ([0-9]+) total.*/\1/')
	if [ "$rc" -ne 0 ]; then
		FAILURES=$((FAILURES + 1))
		printf "%-16s" "EXIT=$rc"
	elif [ -z "$count" ]; then
		FAILURES=$((FAILURES + 1))
		printf "%-16s" "NO LEAK REPORT"
	elif [ "$count" -gt 0 ]; then
		FAILURES=$((FAILURES + 1))
		printf "%-16s" "$count LEAKS (${bytes} B)"
	else
		printf "%-16s" "0 leaks"
	fi
}

# ── Build all ────────────────────────────────────────────────────────────────

echo "building (release=$RELEASE) into $WORK ..."
for entry in "${BENCHES[@]}"; do
	IFS='|' read -r bench small large <<<"$entry"
	selected "$bench" || continue
	[ -f "$BENCH_DIR/nomen/$bench.nm" ] || continue
	if ! "$TSX" "$BENCH_DIR/compile_nomen.ts" "$BENCH_DIR/nomen/$bench.nm" "$WORK/${bench}_a64" "$ROOT/core" aarch64 "$RELEASE" >"$WORK/${bench}_a64.build.log" 2>&1; then
		echo "  aarch64 build failed: $bench (see $WORK/${bench}_a64.build.log)" >&2
	fi
	if ! "$TSX" "$BENCH_DIR/compile_nomen.ts" "$BENCH_DIR/nomen/$bench.nm" "$WORK/${bench}_c" "$ROOT/core" c "$RELEASE" >"$WORK/${bench}_c.build.log" 2>&1; then
		echo "  c build failed: $bench (see $WORK/${bench}_c.build.log)" >&2
	fi
done
echo ""

# ── Run under the leak detector ──────────────────────────────────────────────

RUNS=0
printf "| %-15s | %-28s | %-16s | %-16s |\n" "Bench" "args" "Nomen/A" "Nomen/C"
printf "| %-15s | %-28s | %-16s | %-16s |\n" "---------------" "----------------------------" "----------------" "----------------"

for entry in "${BENCHES[@]}"; do
	IFS='|' read -r bench small large <<<"$entry"
	selected "$bench" || continue
	if [ ! -f "$BENCH_DIR/nomen/$bench.nm" ]; then
		printf "| %-15s | %-28s | %-16s | %-16s |\n" "$bench" "-" "SKIP (no .nm)" "SKIP (no .nm)"
		continue
	fi

	if [ "$LARGE" = 1 ] && [ "$small" != "$large" ]; then
		sizes=(small large)
	else
		sizes=(small)
	fi

	for size in "${sizes[@]}"; do
		if [ "$size" = small ]; then args=$small; else args=$large; fi
		# Shorten input paths so the args column stays readable.
		display_args=${args//"$BENCH_DIR"/…}
		printf "| %-15s | %-28s | " "$bench" "$display_args"
		leak_cell "$WORK/${bench}_a64" $args
		printf " | "
		leak_cell "$WORK/${bench}_c" $args
		printf " |\n"
		RUNS=$((RUNS + 1))
	done
done

echo ""
if [ "$FAILURES" -gt 0 ]; then
	echo "FAIL: $FAILURES problem(s) across $RUNS workload row(s); logs kept in $WORK" >&2
	exit 1
fi

echo "all clean: $RUNS workload row(s) x 2 backends, 0 leaks everywhere"
