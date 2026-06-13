# Echo Benchmark Suite

## Converted Benchmarks

These benchmarks have been converted to Echo and are included in `benchmark.sh`.

| Benchmark      | Echo | Go  | Zig | Notes                                                                   |
| -------------- | ---- | --- | --- | ----------------------------------------------------------------------- |
| pidigits       | ✅   | ✅  | ✅  | BigInt digit computation                                                |
| helloworld     | ✅   | ✅  | -   | Trivial startup test                                                    |
| fannkuch-redux | ✅   | ✅  | -   | Permutation/flip counting (single-threaded)                             |
| binarytrees    | ✅   | ✅  | -   | Recursive tree allocation using classes                                 |
| merkletrees    | ✅   | ✅  | -   | Merkle tree hash computation using classes                              |
| nsieve         | ✅   | -   | -   | Sieve of Eratosthenes using Buffer (Go needs external `bitset` package) |

## Not Converted

The remaining Go benchmarks require language features or standard library support that Echo does not currently have.

### Needs floating-point arrays and/or math functions

| Benchmark         | What's needed                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **mandelbrot**    | Float64 arrays for pixel data, MD5 hash for output verification. Core computation is just float arithmetic in a loop.                                                  |
| **nbody**         | Float struct fields work, but needs `sqrt()` (could use inline C). No float arrays needed — uses structs. Feasible with a small inline C sqrt helper.                  |
| **spectral-norm** | Float64 arrays for vector math, `sqrt()` for final result. Would need a Buffer-based float array abstraction or inline C helpers.                                      |
| **edigits**       | BigInt operations work, but the stopping criterion uses `math.Log`, `math.Pi`, and `math.Ln10`. Would need inline C for these floating-point math constants/functions. |

### Needs random number generation

| Benchmark | What's needed                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fasta** | A simple LCG random number generator (the Go version implements its own). Also needs buffered string output. The concurrent Go version would need to be simplified to single-threaded. Feasible with inline C for the RNG. |

### Needs concurrency primitives

| Benchmark            | What's needed                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **coro-prime-sieve** | Goroutines and channels for the daisy-chain prime sieve. Would require a completely different single-threaded algorithm (e.g., trial division). |
| **binarytrees (Go)** | The Go version uses `sync.WaitGroup` and goroutines for parallelism. The Echo version is single-threaded but produces identical results.        |

### Needs hash maps

| Benchmark       | What's needed                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **lru**         | Hash map (`map[K]V`) and doubly-linked list (`container/list`). Would need a custom hash map implementation in Echo.         |
| **knucleotide** | Hash maps for nucleotide frequency counting, plus file I/O to read input data. Also needs bitwise operations on byte arrays. |

### Needs file I/O

| Benchmark       | What's needed                                                                |
| --------------- | ---------------------------------------------------------------------------- |
| **knucleotide** | File reading (`os.Open`, `bufio.Scanner`) to parse DNA sequence input files. |
| **regex-redux** | File reading for input, plus regex substitution engine.                      |
| **json-serde**  | File reading for JSON input, JSON parser and serializer.                     |

### Needs regex engine

| Benchmark       | What's needed                                       |
| --------------- | --------------------------------------------------- |
| **regex-redux** | Full regex compilation, matching, and substitution. |

### Needs external libraries

| Benchmark       | What's needed                                                   |
| --------------- | --------------------------------------------------------------- |
| **secp256k1**   | CGO bindings to `libsecp256k1` for elliptic curve cryptography. |
| **http-server** | HTTP server (`fasthttp`) and client (`net/http`) libraries.     |

## Easiest to Convert Next

In order of feasibility:

1. **nbody** — Only needs `sqrt()` via a small inline C helper. Struct-based float math works already.
2. **fasta** — Needs a simple LCG RNG (inline C). Single-threaded version is straightforward.
3. **edigits** — Needs `log()` and math constants (inline C). BigInt already works.
4. **mandelbrot** — Needs float64 array access pattern (could reuse Buffer with reinterpret casts).
5. **spectral-norm** — Same float array need as mandelbrot, plus sqrt.
