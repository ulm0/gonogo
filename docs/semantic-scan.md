# Market scan: local semantic search for Node (before phase 1)

Date 2026-11-21. Asked by FLIGHT for the Director, who likes sqlite-vec. Constraint: runs in Node 24, offline, no Python, no API key by default; the use is the Mission Log, about 2,000 entries per room. gonogo ships as a `node:24-bookworm-slim` image (Debian, glibc; the Dockerfile says "never Alpine": its pty library has glibc-only binaries), `engines: node >=24`, and already has BM25 search in memory (`logsearch.ts`).

**Method.** Stars, last push, licence and archived flag from the GitHub API today; sizes, platforms, install scripts and licences from each package's npm metadata (`dist.unpackedSize` of the latest version: the size on disk after install, not the download); model sizes from the Hugging Face API (`?blobs=true`). The timings are mine, on this host (i7-8705G, 8 threads, **busy with other agents**, so read them as an order of magnitude). Doc statements come from the vendors' pages through a page reader; "not stated" means the page I could read does not say it. **Not run:** sqlite-vec, transformers.js, LanceDB, Orama and the others were not installed or started here (the environment refused installing and running a third-party native extension), so nothing below says "I loaded it in node:sqlite and it worked"; it says what the docs and packages say.

## Verdict on sqlite-vec

**At 2,000 entries brute force wins; sqlite-vec is not worth its binary yet.** Reasons:
- **Retrieval is not the cost.** A plain scan of 2,000 x 384 floats plus top-10 took **about 7 to 10 ms** per query here (768 dimensions: about 30 ms; 20,000 x 384: about 135 to 210 ms; 100,000 x 384: about 0.8 to 1 s). The matrix is 2.9 MiB. Embedding the query costs more than the search (see below).
- **sqlite-vec's own docs give no speed number and no ANN.** Its performance page has only a bullet list; its KNN pages describe a brute-force scan too ("perform a brute-force KNN query"). So it is the same linear scan in C, in a virtual table: faster per query, but not a different complexity. Its version in the docs is `v0.1.10-alpha.4` and the docs banner says "work-in-progress"; the npm package is 0.1.9 (2026-03-31) and the repository's last push is **2026-05-18**, six months ago, with one author (8,273 stars, Apache-2.0 / MIT).
- **It costs a native binary per platform.** The `sqlite-vec` package is 4 KB and pulls one optional package: linux-x64 160 KB, linux-arm64 157 KB, darwin-arm64 162 KB, darwin-x64 128 KB, windows-x64 290 KB. Small. But there is **no linux musl, no windows-arm64**, and loading needs `node:sqlite` opened with `{ allowExtension: true }` then `sqliteVec.load(db)` (the docs: Node 23.5 or above; `node:sqlite` is the one gonogo would use, it has `loadExtension`, and I confirmed this host's Node 24.22.3 exposes it and SQLite 3.54.1). The Docker image is glibc, so the Linux packages fit; the image grows by under 0.2 MB.
- **It brings a second store.** The Mission Log is files plus an in-memory BM25 index. sqlite-vec needs a SQLite database to live in: a new file, new migration and crash story, for 2,000 rows.

**Where it would win:** past roughly 20,000 to 50,000 entries per room (a scan of tens of ms and rising), or if gonogo adopted SQLite for something else anyway. A hedge that costs little: keep vectors in a `Float32Array` behind one function (`nearest(query, k)`), so the day a scan is too slow the body can become sqlite-vec or an ANN index without touching callers.

## The list

"Fit" is how it would sit in gonogo with about 2,000 entries per room. All stars and dates are from the GitHub API on 2026-11-21.

### Vector stores

| Tool | What it is | Install and binaries | Platforms | Licence | Maturity | Fit |
|---|---|---|---|---|---|---|
| **Plain cosine on a `Float32Array`** (the baseline) | A flat matrix of normalised vectors and a dot product | none; 2.9 MiB for 2,000 x 384; about 7 to 10 ms per query (above) | wherever Node runs | n/a | trivial | **Best at this size.** Persist the matrix as a file next to the entries (`<id>.vec`, or one blob), rebuild a missing one |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | SQLite extension, `vec0` virtual table, brute-force KNN | 4 KB + one 128 to 290 KB binary per platform (separate optional npm packages) | linux x64/arm64, macOS x64/arm64, windows x64; no musl, no windows-arm64 | MIT OR Apache-2.0 (repo: Apache-2.0) | 8,273 stars, pushed 2026-05-18, docs say alpha/WIP | Works through `node:sqlite` (extension load). Not needed at 2,000; a hedge for 20,000+ |
| [LanceDB](https://github.com/lancedb/lancedb) (`@lancedb/lancedb`) | Embedded columnar vector database with ANN indexes and full-text | **215 MB** (linux x64 glibc) or **426 MB** (linux arm64 glibc) of native package, plus musl/mac/windows variants; the main package is 1.5 MB | linux x64/arm64 (gnu and musl), macOS arm64, windows x64 (per its optional packages) | Apache-2.0 | 11,957 stars, pushed today, v0.41.0 (pre-1.0), company-backed | Powerful and far too big: the binary is bigger than gonogo's whole image layer. For millions of rows |
| [Orama](https://github.com/oramasearch/orama) (`@orama/orama`) | In-process JS search: full text (BM25), vector, and hybrid | 2.2 MB, no dependencies, no native code | pure JS | Apache-2.0 (the API reports `NOASSERTION`: its repository has more than one licence file) | 10,618 stars, repo pushed 2026-10-18, npm 3.1.18 published 2025-12-19 | A candidate if gonogo wanted BM25 + vector in one JS library, but it would replace `logsearch.ts` that already works; I could not read its hybrid-search page, so the claim "BM25 plus vector in process" is from its package description, not read in its docs |
| [hnswlib-node](https://github.com/yoshoku/hnswlib-node) | Node binding of hnswlib (ANN, HNSW graph) | 196 KB, **has an `install` script** (compiles C++ with node-gyp unless a prebuilt matches) | where it compiles | Apache-2.0 | 139 stars, pushed 2026-11-20, npm 3.0.0 published 2024-03 | An install-time compile on every platform and an ANN graph for 2,000 vectors: all cost, no gain |
| [USearch](https://github.com/unum-cloud/usearch) (`usearch`) | Fast ANN/HNSW engine with a Node binding | 25 MB, has an `install` script | prebuilt for the main platforms (per its package) | Apache-2.0 | 4,389 stars, pushed 2026-11-18, npm 2.26.5 | Same verdict as hnswlib: ANN is for 100k+ |
| [vectra](https://github.com/Stevenic/vectra) | A local vector database in JSON files, pure JS | 2.2 MB, 13 dependencies, no native code | pure JS | MIT | 636 stars, pushed 2026-07-20, npm 0.15.0 | In effect the flat-file brute-force store, packaged. It would add 13 dependencies for something 40 lines do; fine as a reference, not as a dependency |

### Embedding sources (turning text into vectors)

The search needs the same model for the entries and for the query, so its cost is per entry written and per query.

| Tool | What it is | Install and binaries | Model and first use | Licence | Maturity | Fit |
|---|---|---|---|---|---|---|
| [transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers`) | Runs ONNX models in JS (browser and Node) | 10 MB itself, **plus `onnxruntime-node` 308 MB** (a `postinstall` script; Linux, macOS, Windows) | Models are fetched from the Hugging Face Hub on first use by default; `env.allowRemoteModels = false` and `env.localModelPath` use a local copy (documented on its custom-usage page). Its docs I could read do not state the cache folder. `Xenova/all-MiniLM-L6-v2` (384 dim, Apache-2.0): **21.9 MB** quantized (int8), 86 MB full; `bge-small-en-v1.5` 32 MB; `multilingual-e5-small` 113 MB; `nomic-embed-text-v1.5` 131 MB | Apache-2.0 (models vary: MiniLM and nomic are Apache-2.0, two of the others state none) | 16,439 stars, pushed 2026-11-18, v4.3.2 | The standard answer for "embeddings in Node, no Python". **Heavy**: about 330 MB of native runtime plus a 22 MB model, a first-run download that fails offline unless the model is shipped. CPU time per 800-character chunk: **not documented, and not measured here** (could not run it) |
| [fastembed-js](https://github.com/Anush008/fastembed-js) (`fastembed`) | Qdrant's ONNX embedding wrapper for Node | 112 KB + dependencies (it uses onnxruntime-node too) | downloads a model on first use | MIT | **archived** repository (last push 2026-09-24, 177 stars); npm 3.0.0 | Do not use: archived |
| [Ollama](https://github.com/ollama/ollama) `/api/embed` | A local server that runs models, including embedding models | the `ollama` npm client is 138 KB; the server is a separate install (Go binary, GBs of models) | the user pulls a model into their Ollama | MIT | 187,783 stars, pushed today | **No bundled dependency, no native code in gonogo, offline once pulled.** Works only if the Director already runs Ollama; an optional provider, never the default |
| [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) | llama.cpp bindings for Node; can run GGUF embedding models | 41 MB + 28 dependencies + per-platform binary packages (x64/arm64/armv7/riscv64, CUDA variants) | GGUF models are downloaded by the user or the CLI | MIT | 2,207 stars, pushed 2026-11-18, v3.22.3 | An alternative to ONNX with a similar weight (tens of MB plus a model of 100s of MB). More complex than transformers.js for the same job |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | the engine under Ollama and node-llama-cpp | a C++ build | GGUF | MIT | 135,881 stars | Mentioned only because two tools above wrap it |

### Memory products (for comparison only)

| Tool | What it is | Licence, activity | Compared with gonogo's Mission Log |
|---|---|---|---|
| [mem0](https://github.com/mem0ai/mem0) (`mem0ai`) | A memory layer that extracts "memories" from conversations with an LLM and stores vectors; Node SDK 4 MB | Apache-2.0, 69,289 stars, pushed 2026-11-18 | Needs an LLM and an embedder to run (a hosted key by default): the opposite of offline-by-default. It decides what to remember; the Mission Log is what agents chose to write |
| [Letta](https://github.com/letta-ai/letta) | A platform for stateful agents with their own memory; `@letta-ai/letta-client` is an SDK to its server | Apache-2.0, 25,505 stars, pushed 2026-10-18 | A whole agent runtime, not a search library |
| [MemPalace](https://github.com/MemPalace/mempalace) | A local memory system for AI conversations (covered by FIDO) | MIT, 60,644 stars, pushed 2026-11-20 | Not examined further here |

Other things seen and left out: [tfjs](https://github.com/tensorflow/tfjs) (19,160 stars, last push 2026-06-23) can run embedding models but is heavier and slower than ONNX for this; [gpt4all](https://github.com/nomic-ai/gpt4all) last pushed 2025-05-27; Meilisearch and Typesense are servers (and Typesense is GPL-3.0); tantivy is Rust.

## How it would sit in gonogo

1. **Where the vectors live.** Next to the entries in `<home>/mission-log/`, one file per entry (`<id>.vec`, a header with the model id and dimension, then the floats) or one `index.vec`. At 2,000 x 384 x 4 bytes that is 3 MB per room. The model id in the header means changing the model re-embeds instead of mixing spaces.
2. **Search.** Keep BM25 (`logsearch.ts`) and add the cosine score; combine by reciprocal-rank fusion (no tuning). Hybrid beats either alone for short queries with a rare word, and BM25 still works with no model at all.
3. **The embedder is the real decision**, not the store: an optional provider behind one function `embed(texts) -> Float32Array[]`. Options in order of cost to gonogo: **off (BM25 only, today)**; **Ollama** if the Director runs it (no dependency); **transformers.js** with a shipped quantized model (about 330 MB of runtime plus 22 MB, an opt-in install, not in the image by default). An API key provider is possible but breaks "offline, no key by default", so it would be a deliberate switch.
4. **Cost per write.** Embedding an entry (a few hundred characters) happens when it is written, off the request path. Not measured here; on a busy CPU a MiniLM-sized model is usually tens of ms per chunk, which is an expectation, not a figure I have.
5. **Never block on it.** A missing or failing embedder means search falls back to BM25 and the entry is queued for embedding later.

## What is unclear or not done

- **Nothing was loaded.** I could not install and run sqlite-vec, transformers.js or any other package here, so no load, speed or size number for them is mine; only the brute-force timings are. A short spike (install in a scratch folder with `--ignore-scripts`, load into `node:sqlite`, 2,000 random vectors) would turn the sqlite-vec part into a measurement; it needs a go-ahead in an environment that allows it.
- **Brute-force timings** were taken on a busy host and include JIT warm-up noise; 7 to 10 ms at 2,000 x 384 is probably high.
- **sqlite-vec platforms:** the platform packages come from npm metadata; its docs I read do not mention separate packages, musl or Windows ARM. Max vector count and dimension limits are not stated on the pages I read.
- **transformers.js:** cache folder, offline recipe and CPU time per chunk are not stated in what I could read (the install page was long and partly summarised). **Orama:** its hybrid-search and vector pages returned only navigation text.
- **LanceDB platforms** come from its npm optional packages, not its docs (which do not state them).
- Star counts of 2026 repositories say little about quality.
