#!/usr/bin/env bash
set -euo pipefail

N=${1:-500}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_DIR="$ROOT/bench"
TSX="$ROOT/bin/node_modules/.bin/tsx"
GO_BUILD="$BENCH_DIR/go/build"
TMPDIR="${TMPDIR:-/tmp}/echo_bench_$$"
mkdir -p "$TMPDIR" "$GO_BUILD"

trap 'rm -rf "$TMPDIR"' EXIT

to_ms() {
	local t="$1"
	local min=$(echo "$t" | sed 's/m.*//')
	local sec=$(echo "$t" | sed 's/.*m//' | sed 's/s$//')
	echo "$min * 60000 + $sec * 1000" | bc | cut -d. -f1
}

time_cmd() {
	local label="$1"; shift
	{ time "$@" > /dev/null 2>&1; } 2>"$TMPDIR/_time.txt"
	local real=$(grep real "$TMPDIR/_time.txt" | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//')
	to_ms "$real"
}

# ── Benchmark definitions ────────────────────────────────────────────────────

BENCHES=(
	"pidigits|$N|pidigits1.zig"
	"helloworld|0|helloworld1.zig"
	"fannkuch-redux|10|fannkuch-redux1.zig"
	"binarytrees|15|binarytrees1.zig"
	"merkletrees|15|merkletrees1.zig"
	"nsieve|4|nsieve1.zig"
	"lru|$N $N|lru1.zig"
	"knucleotide|$BENCH_DIR/knucleotide_input.txt|"
	"json-serde|$N|"
	"regex-redux|$BENCH_DIR/25000_in|"
	"nbody|$N|nbody1.zig"
	"spectral-norm|100|spectral-norm1.zig"
	"mandelbrot|200|mandelbrot1.zig"
	"edigits|27|edigits1.zig"
)

# ── Compile all ──────────────────────────────────────────────────────────────

echo "=== Compile times ==="
echo ""

printf "  %-22s  %7s  %7s  %7s\n" "Benchmark" "Echo" "Go" "Zig"
printf "  %-22s  %7s  %7s  %7s\n" "" "compile" "compile" "compile"
printf "  %-22s  %7s  %7s  %7s\n" "----------------------" "-------" "-------" "-------"

for entry in "${BENCHES[@]}"; do
		IFS='|' read -r bench bn zig_src <<< "$entry"
		echo_ms="-" go_ms="-" zig_ms="-"

		# Echo compile
		if [ -f "$BENCH_DIR/echo/$bench.echo" ]; then
			cp "$BENCH_DIR/echo/package.jsonc" "$TMPDIR/package.jsonc" 2>/dev/null || true
			if raw=$( { time "$TSX" "$BENCH_DIR/compile_echo.ts" "$BENCH_DIR/echo/$bench.echo" "$TMPDIR/echo_${bench}" "$ROOT/core" 2>/dev/null; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//'); then
				echo_ms="$(to_ms "$raw")ms"
			else
				echo_ms="FAIL"
			fi
		else
			echo_ms="SKIP"
		fi

		# Go compile
		if [ -f "$BENCH_DIR/go/$bench.go" ]; then
			if raw=$( { time go build -o "$GO_BUILD/$bench" "$BENCH_DIR/go/$bench.go" 2>/dev/null; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//'); then
				go_ms="$(to_ms "$raw")ms"
			else
				go_ms="FAIL"
			fi
		else
			go_ms="SKIP"
		fi

		# Zig compile
		zig_file="$BENCH_DIR/zig/src/$zig_src"
		if [ -n "$zig_src" ] && [ -f "$zig_file" ]; then
			if raw=$( { time zig build-exe -O ReleaseFast -femit-bin="$TMPDIR/zig_${bench}" "$zig_file" -lc 2>/dev/null; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//'); then
				zig_ms="$(to_ms "$raw")ms"
			else
				zig_ms="FAIL"
			fi
		else
			zig_ms="SKIP"
		fi

		printf "  %-22s  %7s  %7s  %7s\n" "$bench" "$echo_ms" "$go_ms" "$zig_ms"
	done

echo ""

# ── Run all ──────────────────────────────────────────────────────────────────

echo "=== Run times (n=$N) ==="
echo ""

printf "  %-22s  %7s  %7s  %7s\n" "Benchmark" "Echo" "Go" "Zig"
printf "  %-22s  %7s  %7s  %7s\n" "" "run" "run" "run"
printf "  %-22s  %7s  %7s  %7s\n" "----------------------" "-------" "-------" "-------"

for entry in "${BENCHES[@]}"; do
	IFS='|' read -r bench bn zig_src <<< "$entry"
	echo_ms="-" go_ms="-" zig_ms="-"

	# Echo run
	bin_echo="$TMPDIR/echo_${bench}"
	if [ -x "$bin_echo" ]; then
		{ "$bin_echo" $bn > /dev/null 2>&1; } 2>/dev/null || true
		t1=$( { time "$bin_echo" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) 2>/dev/null || true
		t2=$( { time "$bin_echo" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) 2>/dev/null || true
		t3=$( { time "$bin_echo" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) 2>/dev/null || true
		if [ -n "$t1" ] && [ -n "$t2" ] && [ -n "$t3" ]; then
			r1=$(to_ms "$t1") r2=$(to_ms "$t2") r3=$(to_ms "$t3")
			echo_ms=$r1
			[ "$r2" -lt "$echo_ms" ] && echo_ms=$r2
			[ "$r3" -lt "$echo_ms" ] && echo_ms=$r3
			echo_ms="${echo_ms}ms"
		else
			echo_ms="FAIL"
		fi
	else
		echo_ms="FAIL"
	fi

	# Go run
	bin_go="$GO_BUILD/$bench"
	if [ -x "$bin_go" ]; then
		"$bin_go" $bn > /dev/null 2>&1 || true
		t1=$( { time "$bin_go" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		t2=$( { time "$bin_go" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		t3=$( { time "$bin_go" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		if [ -n "$t1" ] && [ -n "$t2" ] && [ -n "$t3" ]; then
			r1=$(to_ms "$t1") r2=$(to_ms "$t2") r3=$(to_ms "$t3")
			go_ms=$r1
			[ "$r2" -lt "$go_ms" ] && go_ms=$r2
			[ "$r3" -lt "$go_ms" ] && go_ms=$r3
			go_ms="${go_ms}ms"
		else
			go_ms="FAIL"
		fi
	else
		go_ms="FAIL"
	fi

	# Zig run
	bin_zig="$TMPDIR/zig_${bench}"
	if [ -x "$bin_zig" ]; then
		"$bin_zig" $bn > /dev/null 2>&1 || true
		t1=$( { time "$bin_zig" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		t2=$( { time "$bin_zig" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		t3=$( { time "$bin_zig" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
		if [ -n "$t1" ] && [ -n "$t2" ] && [ -n "$t3" ]; then
			r1=$(to_ms "$t1") r2=$(to_ms "$t2") r3=$(to_ms "$t3")
			zig_ms=$r1
			[ "$r2" -lt "$zig_ms" ] && zig_ms=$r2
			[ "$r3" -lt "$zig_ms" ] && zig_ms=$r3
			zig_ms="${zig_ms}ms"
		else
			zig_ms="FAIL"
		fi
	else
		zig_ms="FAIL"
	fi

	printf "  %-22s  %7s  %7s  %7s\n" "$bench" "$echo_ms" "$go_ms" "$zig_ms"
done

echo ""
