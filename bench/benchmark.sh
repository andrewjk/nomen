#!/usr/bin/env bash
set -euo pipefail

# Parse -n flags. If none are passed, run with n=500 AND n=2000.
N_LIST=()
while [ $# -gt 0 ]; do
	case "$1" in
		-n) N_LIST+=("$2"); shift 2 ;;
		-n*) N_LIST+=("${1#-n}"); shift ;;
		*) shift ;;
	esac
done
[ ${#N_LIST[@]} -eq 0 ] && N_LIST=(500 2000)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_DIR="$ROOT/bench"
TSX="$ROOT/bin/node_modules/.bin/tsx"
GO_BUILD="$BENCH_DIR/go/build"
RUST_DIR="$BENCH_DIR/rust"
CARGO="cargo"
TMPDIR="${TMPDIR:-/tmp}/echo_bench_$$"
mkdir -p "$TMPDIR" "$GO_BUILD"

trap 'rm -rf "$TMPDIR"' EXIT

to_ms() {
	local t="$1"
	local min=$(echo "$t" | sed 's/m.*//')
	local sec=$(echo "$t" | sed 's/.*m//' | sed 's/s$//')
	echo "$min * 60000 + $sec * 1000" | bc | cut -d. -f1
}

# ── Benchmark definitions ────────────────────────────────────────────────────
# Format: name|args|zig_src|rust_src
# `$N` in args stays literal and is expanded per run; `$BENCH_DIR` expands now.

BENCHES=(
	"pidigits|\$N|pidigits1.zig|pidigits1.rs"
	"helloworld|0|helloworld1.zig|helloworld1.rs"
	"fannkuch-redux|10|fannkuch-redux1.zig|fannkuch-redux1.rs"
	"binarytrees|15|binarytrees1.zig|binarytrees3.rs"
	"merkletrees|15|merkletrees1.zig|merkletrees1.rs"
	"nsieve|4|nsieve1.zig|nsieve1.rs"
	"lru|\$N \$N|lru1.zig|lru1.rs"
	"knucleotide|$BENCH_DIR/knucleotide_input.txt|knucleotide1.zig|knucleotide8.rs"
	"json-serde|$BENCH_DIR/sample.json \$N|json-serde1.zig|json-serde1.rs"
	"regex-redux|$BENCH_DIR/25000_in|regex-redux1.zig|regex-redux6.rs"
	"nbody|\$N|nbody1.zig|nbody1.rs"
	"spectral-norm|100|spectral-norm1.zig|spectral-norm1.rs"
	"mandelbrot|200|mandelbrot1.zig|mandelbrot8.rs"
	"edigits|27|edigits1.zig|edigits1.rs"
)

# ── Compile all ──────────────────────────────────────────────────────────────

# Warm up the Rust dependency tree (untimed) so per-benchmark Rust compile
# times reflect compiling each benchmark's own code, not its dependencies.
( cd "$RUST_DIR" && $CARGO build --release --quiet 2>/dev/null ) || true

echo "=== Compile times ==="
echo ""

printf "  %-22s  %7s  %7s  %7s  %7s\n" "Benchmark" "Echo" "Go" "Zig" "Rust"
printf "  %-22s  %7s  %7s  %7s  %7s\n" "" "compile" "compile" "compile" "compile"
printf "  %-22s  %7s  %7s  %7s  %7s\n" "----------------------" "-------" "-------" "-------" "-------"

for entry in "${BENCHES[@]}"; do
	IFS='|' read -r bench bn zig_src rust_src <<< "$entry"
	echo_ms="-" go_ms="-" zig_ms="-" rust_ms="-"

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

	# Rust compile (force a rebuild of this benchmark so the time is meaningful;
	# shared dependencies stay cached from the warm-up above)
	if [ -n "$rust_src" ] && [ -f "$RUST_DIR/$rust_src" ]; then
		touch "$RUST_DIR/$rust_src"
		if raw=$( { time ( cd "$RUST_DIR" && $CARGO build --release --bin "$bench" --quiet 2>/dev/null ); } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//'); then
			rust_ms="$(to_ms "$raw")ms"
		else
			rust_ms="FAIL"
		fi
	else
		rust_ms="SKIP"
	fi

	printf "  %-22s  %7s  %7s  %7s  %7s\n" "$bench" "$echo_ms" "$go_ms" "$zig_ms" "$rust_ms"
done

echo ""

# ── Run all ──────────────────────────────────────────────────────────────────

for N in "${N_LIST[@]}"; do
	echo "=== Run times (n=$N) ==="
	echo ""

	printf "  %-22s  %7s  %7s  %7s  %7s\n" "Benchmark" "Echo" "Go" "Zig" "Rust"
	printf "  %-22s  %7s  %7s  %7s  %7s\n" "" "run" "run" "run" "run"
	printf "  %-22s  %7s  %7s  %7s  %7s\n" "----------------------" "-------" "-------" "-------" "-------"

	for entry in "${BENCHES[@]}"; do
		IFS='|' read -r bench bn zig_src rust_src <<< "$entry"
		bn=${bn//\$N/$N}
		echo_ms="-" go_ms="-" zig_ms="-" rust_ms="-"

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

		# Rust run
		bin_rust="$RUST_DIR/target/release/$bench"
		if [ -x "$bin_rust" ]; then
			"$bin_rust" $bn > /dev/null 2>&1 || true
			t1=$( { time "$bin_rust" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
			t2=$( { time "$bin_rust" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
			t3=$( { time "$bin_rust" $bn > /dev/null 2>&1; } 2>&1 | grep real | sed 's/real[[:space:]]*//' | sed 's/[[:space:]]*$//' ) || true
			if [ -n "$t1" ] && [ -n "$t2" ] && [ -n "$t3" ]; then
				r1=$(to_ms "$t1") r2=$(to_ms "$t2") r3=$(to_ms "$t3")
				rust_ms=$r1
				[ "$r2" -lt "$rust_ms" ] && rust_ms=$r2
				[ "$r3" -lt "$rust_ms" ] && rust_ms=$r3
				rust_ms="${rust_ms}ms"
			else
				rust_ms="FAIL"
			fi
		else
			rust_ms="FAIL"
		fi

		printf "  %-22s  %7s  %7s  %7s  %7s\n" "$bench" "$echo_ms" "$go_ms" "$zig_ms" "$rust_ms"
	done

	echo ""
done
