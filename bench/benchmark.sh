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

# compile_echo <bench_name>
compile_echo() {
	local bench="$1"
	echo "  Compiling echo/$bench..." >&2
	cp "$BENCH_DIR/echo/package.jsonc" "$TMPDIR/package.jsonc"
	"$TSX" "$BENCH_DIR/compile_echo.ts" "$BENCH_DIR/echo/$bench.echo" "$TMPDIR/echo_${bench}" "$ROOT/lib" 2>"$TMPDIR/echo_${bench}_err.txt" || {
		echo "  FAIL: Echo $bench compilation failed" >&2
		cat "$TMPDIR/echo_${bench}_err.txt" >&2
		return 1
	}
}

# compile_go <bench_name>
compile_go() {
	local bench="$1"
	echo "  Compiling go/$bench..." >&2
	go build -o "$GO_BUILD/$bench" "$BENCH_DIR/go/$bench.go" 2>"$TMPDIR/go_${bench}_err.txt" || {
		echo "  FAIL: Go $bench compilation failed" >&2
		cat "$TMPDIR/go_${bench}_err.txt" >&2
		return 1
	}
}

# compile_zig <bench_name> [src_file_override]
compile_zig() {
	local name="$1" src="$2"
	echo "  Compiling zig/$name..." >&2
	if [ ! -f "$src" ]; then
		echo "  SKIP: No Zig benchmark for $name" >&2
		return 1
	fi
	zig build-exe -O ReleaseFast -femit-bin="$TMPDIR/zig_${name}" "$src" -lc 2>"$TMPDIR/zig_${name}_err.txt" || {
		echo "  FAIL: Zig $name compilation failed" >&2
		cat "$TMPDIR/zig_${name}_err.txt" >&2
		return 1
	}
}

# ── Benchmark runner ─────────────────────────────────────────────────────────

RESULTS_FILE="$TMPDIR/results.txt"
> "$RESULTS_FILE"

echo "=== Echo Benchmark Suite (n=$N) ==="
echo ""

# ── Compile all first ─────────────────────────────────────────────────────────

echo "=== Compiling all benchmarks ==="
echo ""

compile_echo pidigits && echo "  echo/pidigits OK" || echo "  echo/pidigits FAIL"
compile_go pidigits && echo "  go/pidigits OK" || echo "  go/pidigits FAIL"
compile_zig pidigits "$BENCH_DIR/zig/src/pidigits1.zig" && echo "  zig/pidigits OK" || echo "  zig/pidigits FAIL"

compile_echo helloworld && echo "  echo/helloworld OK" || echo "  echo/helloworld FAIL"
compile_go helloworld && echo "  go/helloworld OK" || echo "  go/helloworld FAIL"
compile_zig helloworld "$BENCH_DIR/zig/src/helloworld1.zig" && echo "  zig/helloworld OK" || echo "  zig/helloworld SKIP"

compile_echo fannkuch-redux && echo "  echo/fannkuch-redux OK" || echo "  echo/fannkuch-redux FAIL"
compile_go fannkuch-redux && echo "  go/fannkuch-redux OK" || echo "  go/fannkuch-redux FAIL"
compile_zig fannkuch-redux "$BENCH_DIR/zig/src/fannkuch-redux1.zig" && echo "  zig/fannkuch-redux OK" || echo "  zig/fannkuch-redux SKIP"

compile_echo binarytrees && echo "  echo/binarytrees OK" || echo "  echo/binarytrees FAIL"
compile_go binarytrees && echo "  go/binarytrees OK" || echo "  go/binarytrees FAIL"
compile_zig binarytrees "$BENCH_DIR/zig/src/binarytrees1.zig" && echo "  zig/binarytrees OK" || echo "  zig/binarytrees SKIP"

compile_echo merkletrees && echo "  echo/merkletrees OK" || echo "  echo/merkletrees FAIL"
compile_go merkletrees && echo "  go/merkletrees OK" || echo "  go/merkletrees FAIL"
compile_zig merkletrees "$BENCH_DIR/zig/src/merkletrees1.zig" && echo "  zig/merkletrees OK" || echo "  zig/merkletrees SKIP"

compile_echo nsieve && echo "  echo/nsieve OK" || echo "  echo/nsieve FAIL"
compile_go nsieve 2>/dev/null && echo "  go/nsieve OK" || echo "  go/nsieve FAIL (expected)"
compile_zig nsieve "$BENCH_DIR/zig/src/nsieve1.zig" && echo "  zig/nsieve OK" || echo "  zig/nsieve SKIP"

compile_echo nbody && echo "  echo/nbody OK" || echo "  echo/nbody FAIL"
compile_go nbody && echo "  go/nbody OK" || echo "  go/nbody FAIL"
compile_zig nbody "$BENCH_DIR/zig/src/nbody1.zig" && echo "  zig/nbody OK" || echo "  zig/nbody SKIP"

compile_echo spectral-norm && echo "  echo/spectral-norm OK" || echo "  echo/spectral-norm FAIL"
compile_go spectral-norm && echo "  go/spectral-norm OK" || echo "  go/spectral-norm FAIL"
compile_zig spectral-norm "$BENCH_DIR/zig/src/spectral-norm1.zig" && echo "  zig/spectral-norm OK" || echo "  zig/spectral-norm SKIP"

compile_echo mandelbrot && echo "  echo/mandelbrot OK" || echo "  echo/mandelbrot FAIL"
compile_go mandelbrot && echo "  go/mandelbrot OK" || echo "  go/mandelbrot FAIL"
compile_zig mandelbrot "$BENCH_DIR/zig/src/mandelbrot1.zig" && echo "  zig/mandelbrot OK" || echo "  zig/mandelbrot SKIP"

compile_echo edigits && echo "  echo/edigits OK" || echo "  echo/edigits FAIL"
compile_go edigits && echo "  go/edigits OK" || echo "  go/edigits FAIL"
compile_zig edigits "$BENCH_DIR/zig/src/edigits1.zig" && echo "  zig/edigits OK" || echo "  zig/edigits SKIP"

echo ""

# ── Run benchmarks (compile times measured separately) ─────────────────────────

echo "=== Running benchmarks ==="
echo ""

RESULTS_FILE="$TMPDIR/results.txt"
> "$RESULTS_FILE"

run_one() {
	local label="$1"
	local bench="$2"
	local bn="$3"
	local bin_echo="$TMPDIR/echo_${bench}"
	local bin_go="$GO_BUILD/$bench"
	local bin_zig="$TMPDIR/zig_${bench}"

	local e_compile="-" e_run="-" g_compile="-" g_run="-" z_compile="-" z_run="-"

	echo "── $label ──"

	# Echo compile time
	if [ -x "$bin_echo" ]; then
		e_compile=$( { time "$TSX" "$BENCH_DIR/compile_echo.ts" "$BENCH_DIR/echo/$bench.echo" "$TMPDIR/echo_${bench}" "$ROOT/lib" 2>/dev/null; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' )
		e_compile=$(to_ms "$e_compile")
		# warmup + best of 3
		"$bin_echo" "$bn" > /dev/null 2>&1 || true
		local t1=$( { time "$bin_echo" "$bn" > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' )
		local t2=$( { time "$bin_echo" "$bn" > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' )
		local t3=$( { time "$bin_echo" "$bn" > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' )
		e_run=$(to_ms "$t1")
		local r2=$(to_ms "$t2") local r3=$(to_ms "$t3")
		[ "$r2" -lt "$e_run" ] && e_run=$r2
		[ "$r3" -lt "$e_run" ] && e_run=$r3
		echo "  Echo:  compile=${e_compile}ms  run=${e_run}ms"
	else
		echo "  Echo:  FAIL"
	fi

	# Go compile time
	if [ -x "$bin_go" ]; then
		g_compile=$( { time go build -o "$bin_go" "$BENCH_DIR/go/${bench}.go" 2>/dev/null; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' )
		g_compile=$(to_ms "$g_compile")
		"$bin_go" "$bn" > /dev/null 2>&1 || true
		t1=$( { time "$bin_go" "$bn" > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' )
		t2=$( { time "$bin_go" "$bn" > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' )
		t3=$( { time "$bin_go" "$bn" > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' )
		g_run=$(to_ms "$t1")
		r2=$(to_ms "$t2") r3=$(to_ms "$t3")
		[ "$r2" -lt "$g_run" ] && g_run=$r2
		[ "$r3" -lt "$g_run" ] && g_run=$r3
		echo "  Go:    compile=${g_compile}ms  run=${g_run}ms"
	else
		echo "  Go:    FAIL"
	fi

	# Zig compile time
	if [ -x "$bin_zig" ]; then
		local zig_src="$BENCH_DIR/zig/src/${bench}1.zig"
		[ "$bench" = "pidigits" ] && zig_src="$BENCH_DIR/zig/src/pidigits1.zig"
		z_compile=$( { time zig build-exe -O ReleaseFast -femit-bin="$bin_zig" "$zig_src" -lc 2>/dev/null; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' )
		z_compile=$(to_ms "$z_compile")
		"$bin_zig" "$bn" > /dev/null 2>&1 || true
		t1=$( { time "$bin_zig" "$bn" > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' )
		t2=$( { time "$bin_zig" "$bn" > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' )
		t3=$( { time "$bin_zig" "$bn" > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' )
		z_run=$(to_ms "$t1")
		r2=$(to_ms "$t2") r3=$(to_ms "$t3")
		[ "$r2" -lt "$z_run" ] && z_run=$r2
		[ "$r3" -lt "$z_run" ] && z_run=$r3
		echo "  Zig:   compile=${z_compile}ms  run=${z_run}ms"
	else
		local zig_src="$BENCH_DIR/zig/src/${bench}1.zig"
		[ "$bench" = "pidigits" ] && zig_src="$BENCH_DIR/zig/src/pidigits1.zig"
		echo "  Zig:   $([ -f "$zig_src" ] && echo "FAIL" || echo "SKIP")"
	fi

	echo "$label ${e_compile} ${e_run} ${g_compile} ${g_run} ${z_compile} ${z_run}" >> "$RESULTS_FILE"
	echo ""
}

run_one "pidigits(n=$N)" pidigits $N
run_one "helloworld" helloworld 0
run_one "fannkuch-redux(n=10)" fannkuch-redux 10
run_one "binarytrees(n=15)" binarytrees 15
run_one "merkletrees(n=15)" merkletrees 15
run_one "nsieve(n=4)" nsieve 4
run_one "nbody(n=$N)" nbody $N
run_one "spectral-norm(n=100)" spectral-norm 100
run_one "mandelbrot(n=200)" mandelbrot 200
run_one "edigits(n=27)" edigits 27

# ── Summary ───────────────────────────────────────────────────────────────────

echo "=== Summary ==="
echo ""
printf "  %-22s  %-17s  %-17s  %-17s\n" "Benchmark" "Echo" "Go" "Zig"
printf "  %-22s  %-8s %-8s  %-8s %-8s  %-8s %-8s\n" "" "compile" "run" "compile" "run" "compile" "run"
printf "  %-22s  %-8s %-8s  %-8s %-8s  %-8s %-8s\n" "----------------------" "--------" "--------" "--------" "--------" "--------" "--------"
while IFS=' ' read -r label ec er gc gr zc zr; do
	printf "  %-22s  %4sms %4sms  %4sms %4sms  %4sms %4sms\n" "$label" "$ec" "$er" "$gc" "$gr" "$zc" "$zr"
done < "$RESULTS_FILE"
