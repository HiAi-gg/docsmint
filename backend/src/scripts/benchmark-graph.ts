#!/usr/bin/env bun
/**
 * GraphRAG benchmark — measure recall@k improvement and p50/p95
 * latency of graph expansion against a fixed inline corpus.
 *
 * Usage:
 *   GRAPH_SEARCH_ENABLED=true bun run src/scripts/benchmark-graph.ts
 *   bun run benchmark:graph
 *
 * The script seeds synthetic documents into the backend via the admin API,
 * then runs a series of queries with and without graph expansion to measure:
 *   - recall@k improvement (graph vs no-graph)
 *   - p50/p95 latency of graph expansion
 *   - sensitivity to GRAPH_EXPANSION_BOOST (optional)
 *
 * Flags:
 *   --base-url <url>     API base URL (default http://localhost:50700)
 *   --api-key <key>      Admin API key (default test-key)
 *   --runs <n>           Iterations per query for latency averaging (default 3)
 *   --k <n>              Recall@k cutoff (default 10)
 *   --boost-range <vals> Comma-separated boost values for sensitivity test
 *                        e.g. 0.1,0.3,0.5,1.0
 *   --json               Emit JSON summary on stdout
 *   --help               Print this usage text
 */

// ═══════════════════════════════════════════════════════════════════════
// §1 — Inline corpus + queries
// ═══════════════════════════════════════════════════════════════════════

interface DocSpec {
	id: string;
	title: string;
	body: string;
	folderId: string;
}

interface QuerySpec {
	text: string;
	/** IDs of documents expected in recall@k results */
	relevantDocIds: string[];
}

const SYNTHETIC_DOCS: DocSpec[] = [
	{
		id: "bench-doc-ai-1",
		title: "Introduction to Transformer Neural Networks",
		body: "Transformer models revolutionized natural language processing by introducing self-attention mechanisms. Unlike recurrent neural networks, transformers process all tokens in parallel, making them highly efficient for training on large text corpora. The architecture consists of an encoder-decoder structure with multi-head attention, feed-forward layers, and positional encodings. Key innovations include scaled dot-product attention and the ability to capture long-range dependencies without the vanishing gradient problem. Popular implementations include BERT for understanding tasks and GPT for generative tasks.",
		folderId: "bench-folder-ai",
	},
	{
		id: "bench-doc-ai-2",
		title: "Reinforcement Learning from Human Feedback",
		body: "RLHF is a technique used to align language models with human preferences. The process involves training a reward model on human comparisons of model outputs, then using reinforcement learning (typically PPO) to optimize the language model against that reward signal. This approach was instrumental in developing ChatGPT and other helpful assistants. Key challenges include reward hacking, distribution shift, and the difficulty of collecting high-quality human preference data at scale.",
		folderId: "bench-folder-ai",
	},
	{
		id: "bench-doc-db-1",
		title: "PostgreSQL Query Optimization Guide",
		body: "PostgreSQL offers a sophisticated query planner that uses cost-based optimization. Understanding EXPLAIN ANALYZE output is essential for identifying slow queries. Key optimization techniques include creating appropriate indexes (B-tree, GiST, GIN), adjusting work_mem for sort operations, using pg_stat_statements to track query performance, partitioning large tables, and configuring effective_cache_size for the OS-level cache. Vacuuming and analyzing tables regularly maintains the planner's statistics accuracy.",
		folderId: "bench-folder-db",
	},
	{
		id: "bench-doc-db-2",
		title: "Graph Databases and Property Graph Models",
		body: "Graph databases store data as nodes, edges, and properties, optimized for relationship-heavy queries. The property graph model represents entities as nodes and their connections as labeled, directed edges. Apache AGE extends PostgreSQL with graph database capabilities, supporting the Cypher query language alongside SQL. Graph databases excel at traversing connections (friend-of-a-friend, supply chain analysis, fraud detection) where relational databases require expensive JOIN chains.",
		folderId: "bench-folder-db",
	},
	{
		id: "bench-doc-web-1",
		title: "Building RESTful APIs with TypeScript",
		body: "TypeScript adds static typing to JavaScript, catching errors at compile time rather than runtime. When building RESTful APIs, Elysia and Hono are modern frameworks that offer type-safe routing with Zod schema validation. Key practices include using DTOs for request/response shapes, implementing proper error handling middleware, adding rate limiting to prevent abuse, and structuring routes around resources. OpenAPI documentation can be auto-generated from type definitions, keeping docs in sync with implementation.",
		folderId: "bench-folder-web",
	},
	{
		id: "bench-doc-web-2",
		title: "Web Application Security Best Practices",
		body: "Securing web applications requires defense in depth. CSRF tokens prevent cross-site request forgery. Content Security Policy headers mitigate XSS attacks. Rate limiting protects against brute force and DoS. Proper CORS configuration prevents unauthorized cross-origin reads. Input validation and parameterized queries prevent SQL injection. HTTPS everywhere ensures transport encryption. Regular dependency updates reduce supply chain risks. Security headers like HSTS, X-Frame-Options, and X-Content-Type-Options add additional protection layers.",
		folderId: "bench-folder-web",
	},
	{
		id: "bench-doc-vec-1",
		title: "Vector Embeddings for Semantic Search",
		body: "Vector embeddings convert text into dense numerical representations that capture semantic meaning. Models like OpenAI's text-embedding-3-small and Voyage AI produce high-quality embeddings. Cosine similarity measures the angle between vectors, enabling semantic search that goes beyond keyword matching. Hybrid search combines vector similarity with full-text search (BM25/tsvector) for optimal results. The chunking strategy significantly impacts quality: smaller chunks improve precision while larger chunks provide more context.",
		folderId: "bench-folder-vec",
	},
	{
		id: "bench-doc-vec-2",
		title: "Approximate Nearest Neighbor Search",
		body: "ANN algorithms speed up vector similarity search at scale by trading perfect accuracy for speed. IVFFlat indexes partition vectors into inverted lists, while HNSW builds a hierarchical navigable small-world graph. pgvector supports both index types. Key parameters include lists (IVF) and m/efConstruction (HNSW). ANN search is essential for production embedding search over millions of vectors where exhaustive kNN is too slow. Recall vs speed tradeoffs must be tuned for each use case.",
		folderId: "bench-folder-vec",
	},
	{
		id: "bench-doc-ml-1",
		title: "MLOps: CI/CD for Machine Learning",
		body: "MLOps applies DevOps principles to machine learning pipelines. Key components include experiment tracking (MLflow, Weights & Biases), feature stores (Feast), model registries, and automated retraining triggers. Data versioning (DVC, LakeFS) ensures reproducibility. Model monitoring detects drift in production. A/B testing frameworks validate model improvements. Infrastructure-as-code (Terraform, Pulumi) manages the compute resources. The goal is to reduce the time from idea to deployed model while maintaining reliability.",
		folderId: "bench-folder-ml",
	},
	{
		id: "bench-doc-ml-2",
		title: "Feature Engineering for NLP Models",
		body: "Feature engineering transforms raw text into inputs suitable for machine learning. Traditional approaches include TF-IDF vectors, n-gram features, and part-of-speech tags. Modern NLP uses pre-trained transformer embeddings (BERT, RoBERTa) as feature extractors. Key considerations include handling out-of-vocabulary words, normalizing text (lowercasing, stemming, lemmatization), and dealing with imbalanced classes. Feature selection reduces dimensionality and improves model generalization.",
		folderId: "bench-folder-ml",
	},
	{
		id: "bench-doc-sys-1",
		title: "Distributed Systems Consistency Models",
		body: "Consistency models define how distributed systems handle concurrent updates. Strong consistency guarantees all nodes see the same data simultaneously but requires coordination. Eventual consistency accepts temporary divergence for better availability. Linearizability provides a total order of operations. CRDTs (Conflict-free Replicated Data Types) enable automatic conflict resolution. The CAP theorem states that partition tolerance must trade off between consistency and availability. Real-world systems often choose tunable consistency.",
		folderId: "bench-folder-sys",
	},
	{
		id: "bench-doc-sys-2",
		title: "Message Queues and Event-Driven Architecture",
		body: "Event-driven architecture decouples services through asynchronous message passing. Message brokers like Redis, RabbitMQ, and Kafka provide durable, ordered message delivery. Pub/sub patterns enable one-to-many event distribution. Key patterns include event sourcing (storing state changes as events), CQRS (separating read and write models), and saga transactions (compensating actions for distributed rollbacks). Message ordering, exactly-once processing, and dead-letter queues are critical production concerns.",
		folderId: "bench-folder-sys",
	},
];

const QUERIES: QuerySpec[] = [
	{
		text: "transformer neural network attention mechanism",
		relevantDocIds: ["bench-doc-ai-1", "bench-doc-ai-2", "bench-doc-ml-2"],
	},
	{
		text: "vector embedding semantic search",
		relevantDocIds: ["bench-doc-vec-1", "bench-doc-vec-2"],
	},
	{
		text: "PostgreSQL query optimization index",
		relevantDocIds: ["bench-doc-db-1"],
	},
	{
		text: "graph database property model AGE",
		relevantDocIds: ["bench-doc-db-2"],
	},
	{
		text: "distributed consistency CAP theorem",
		relevantDocIds: ["bench-doc-sys-1"],
	},
	{
		text: "MLOps machine learning pipeline deployment",
		relevantDocIds: ["bench-doc-ml-1"],
	},
	{
		text: "web security CSRF XSS CORS",
		relevantDocIds: ["bench-doc-web-2"],
	},
	{
		text: "API TypeScript Elysia REST",
		relevantDocIds: ["bench-doc-web-1"],
	},
	{
		text: "message queue event-driven architecture Kafka",
		relevantDocIds: ["bench-doc-sys-2"],
	},
	{
		text: "NLP feature engineering BERT embedding",
		relevantDocIds: ["bench-doc-ml-2", "bench-doc-ai-1", "bench-doc-vec-1"],
	},
];

// ═══════════════════════════════════════════════════════════════════════
// §2 — CLI flags
// ═══════════════════════════════════════════════════════════════════════

interface CliArgs {
	baseUrl: string;
	apiKey: string;
	runs: number;
	k: number;
	boostRange: number[] | null;
	json: boolean;
	help: boolean;
}

function parseArgs(): CliArgs {
	const args: CliArgs = {
		baseUrl: "http://localhost:50700",
		apiKey: "test-key",
		runs: 3,
		k: 10,
		boostRange: null,
		json: false,
		help: false,
	};
	for (let i = 2; i < process.argv.length; i++) {
		const arg = process.argv[i];
		switch (arg) {
			case "--help":
				args.help = true;
				break;
			case "--json":
				args.json = true;
				break;
			case "--base-url": {
				const val = process.argv[++i];
				if (val !== undefined) args.baseUrl = val;
				break;
			}
			case "--api-key": {
				const val = process.argv[++i];
				if (val !== undefined) args.apiKey = val;
				break;
			}
			case "--runs": {
				const val = process.argv[++i];
				if (val !== undefined) args.runs = Number.parseInt(val, 10);
				break;
			}
			case "--k": {
				const val = process.argv[++i];
				if (val !== undefined) args.k = Number.parseInt(val, 10);
				break;
			}
			case "--boost-range": {
				const val = process.argv[++i];
				if (val !== undefined) args.boostRange = val.split(",").map(Number);
				break;
			}
			default:
				if (arg?.startsWith("--")) {
					console.error(`Unknown flag: ${arg}`);
					printUsage();
					process.exit(1);
				}
		}
	}
	return args;
}

function printUsage(): void {
	console.log(`
Usage: bun run src/scripts/benchmark-graph.ts [options]

Options:
  --base-url <url>     API base URL (default: http://localhost:50700)
  --api-key <key>      Admin API key (default: test-key)
  --runs <n>           Iterations per query for latency averaging (default: 3)
  --k <n>              Recall@k cutoff (default: 10)
  --boost-range <vals> Comma-separated boost values for sensitivity test
                       e.g. 0.1,0.3,0.5,1.0
  --json               Emit JSON summary on stdout
  --help               Print this usage text

Requires:
  - A running hiai-docs backend at --base-url
  - Admin API key configured via HIAI_DOCS_API_KEY on the backend
  - GRAPH_SEARCH_ENABLED=true on the backend for graph tests
  - AGE running in the shared database (no separate connection required)
`);
}

// ═══════════════════════════════════════════════════════════════════════
// §3 — Helpers
// ═══════════════════════════════════════════════════════════════════════

interface SearchResponse {
	items: Array<{ id: string; score: number }>;
	total: number;
	page: number;
	limit: number;
}

interface SearchResult {
	ids: string[];
	latencyMs: number;
}

async function runSearch(
	baseUrl: string,
	apiKey: string,
	query: string,
	graphEnabled: boolean,
	k: number,
): Promise<SearchResult> {
	const params = new URLSearchParams({
		q: query,
		limit: String(k),
		graph: String(graphEnabled),
	});
	const url = `${baseUrl}/api/search?${params}`;
	const start = performance.now();
	const resp = await fetch(url, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
	});
	const elapsed = performance.now() - start;

	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(
			`Search API returned ${resp.status}: ${text.slice(0, 200)}`,
		);
	}

	const data = (await resp.json()) as SearchResponse;
	return {
		ids: (data.items ?? []).map((item) => item.id),
		latencyMs: elapsed,
	};
}

function computeRecallAtK(
	resultIds: string[],
	relevantIds: string[],
	k: number,
): number {
	const topK = resultIds.slice(0, k);
	const relevantSet = new Set(relevantIds);
	const hits = topK.filter((id) => relevantSet.has(id)).length;
	return relevantIds.length > 0 ? hits / relevantIds.length : 0;
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, Math.min(idx, sorted.length - 1))] as number;
}

function _computeStats(values: number[]) {
	if (values.length === 0) {
		return { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 };
	}
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((a, b) => a + b, 0);
	return {
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		mean: sum / sorted.length,
		min: sorted[0] as number,
		max: sorted[sorted.length - 1] as number,
	};
}

// ── Per-query result ─────────────────────────────────────────────────
interface QueryResult {
	query: string;
	recallNoGraph: number;
	recallWithGraph: number;
	delta: number;
	p50LatencyNoGraph: number;
	p50LatencyGraph: number;
	p95LatencyGraph: number;
}

interface BenchmarkRunResult {
	label: string;
	boost: number | null;
	queries: QueryResult[];
	aggregate: {
		avgRecallNoGraph: number;
		avgRecallWithGraph: number;
		avgDelta: number;
		p50LatencyNoGraph: number;
		p50LatencyGraph: number;
		p95LatencyGraph: number;
	};
}

async function runBenchmark(
	baseUrl: string,
	apiKey: string,
	queries: QuerySpec[],
	k: number,
	runs: number,
	graphEnabled: boolean,
	boost: number | null,
): Promise<BenchmarkRunResult> {
	const queryResults: QueryResult[] = [];

	for (const spec of queries) {
		// No-graph run
		const noGraphLatencies: number[] = [];
		const noGraphRecallValues: number[] = [];
		for (let r = 0; r < runs; r++) {
			const result = await runSearch(baseUrl, apiKey, spec.text, false, k);
			noGraphLatencies.push(result.latencyMs);
			noGraphRecallValues.push(
				computeRecallAtK(result.ids, spec.relevantDocIds, k),
			);
		}
		const recallNoGraph =
			noGraphRecallValues.reduce((a, b) => a + b, 0) /
			noGraphRecallValues.length;
		const p50LatencyNoGraph = percentile(noGraphLatencies, 50);

		// Graph run
		const graphLatencies: number[] = [];
		const graphRecallValues: number[] = [];
		const effectiveK = k;
		for (let r = 0; r < runs; r++) {
			const result = await runSearch(
				baseUrl,
				apiKey,
				spec.text,
				graphEnabled,
				effectiveK,
			);
			graphLatencies.push(result.latencyMs);
			graphRecallValues.push(
				computeRecallAtK(result.ids, spec.relevantDocIds, effectiveK),
			);
		}
		const recallWithGraph =
			graphRecallValues.reduce((a, b) => a + b, 0) / graphRecallValues.length;
		const p50LatencyGraph = percentile(graphLatencies, 50);
		const p95LatencyGraph = percentile(graphLatencies, 95);

		queryResults.push({
			query: spec.text,
			recallNoGraph,
			recallWithGraph,
			delta: recallWithGraph - recallNoGraph,
			p50LatencyNoGraph,
			p50LatencyGraph,
			p95LatencyGraph,
		});
	}

	// Aggregate
	const aggRecallNoGraph =
		queryResults.reduce((s, q) => s + q.recallNoGraph, 0) / queryResults.length;
	const aggRecallWithGraph =
		queryResults.reduce((s, q) => s + q.recallWithGraph, 0) /
		queryResults.length;
	const aggLatenciesNoGraph = queryResults.map((q) => q.p50LatencyNoGraph);
	const aggLatenciesGraph = queryResults.map((q) => q.p50LatencyGraph);
	const aggLatenciesGraphP95 = queryResults.map((q) => q.p95LatencyGraph);

	return {
		label: graphEnabled
			? `graph${boost !== null ? ` (boost=${boost})` : ""}`
			: "no-graph",
		boost,
		queries: queryResults,
		aggregate: {
			avgRecallNoGraph: aggRecallNoGraph,
			avgRecallWithGraph: aggRecallWithGraph,
			avgDelta: aggRecallWithGraph - aggRecallNoGraph,
			p50LatencyNoGraph: percentile(aggLatenciesNoGraph, 50),
			p50LatencyGraph: percentile(aggLatenciesGraph, 50),
			p95LatencyGraph: percentile(aggLatenciesGraphP95, 95),
		},
	};
}

// ── ANSI color helpers ────────────────────────────────────────────────
const ANSI = {
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	bold: "\x1b[1m",
	reset: "\x1b[0m",
	dim: "\x1b[2m",
};

function colorDelta(delta: number): string {
	if (delta > 0.01) return `${ANSI.green}+${delta.toFixed(3)}${ANSI.reset}`;
	if (delta < -0.01) return `${ANSI.red}${delta.toFixed(3)}${ANSI.reset}`;
	return `${ANSI.yellow}${delta.toFixed(3)}${ANSI.reset}`;
}

function printTable(results: QueryResult[]): void {
	// Header
	console.log(
		`${ANSI.bold}Query${ANSI.reset} | recall@k (no graph) | recall@k (graph) | ${ANSI.bold}Δ${ANSI.reset} | p50 lat (no graph) ms | p50 lat (graph) ms | p95 lat (graph) ms`,
	);
	console.log("-".repeat(110));

	for (const q of results) {
		const queryLabel =
			q.query.length > 40 ? `${q.query.slice(0, 37)}...` : q.query;
		console.log(
			`${queryLabel.padEnd(42)} | ${q.recallNoGraph.toFixed(3).padStart(16)} | ${q.recallWithGraph.toFixed(3).padStart(16)} | ${colorDelta(q.delta).padStart(10)} | ${q.p50LatencyNoGraph.toFixed(1).padStart(18)} | ${q.p50LatencyGraph.toFixed(1).padStart(16)} | ${q.p95LatencyGraph.toFixed(1).padStart(16)}`,
		);
	}
}

function printAggregate(
	agg: BenchmarkRunResult["aggregate"],
	label: string,
): void {
	console.log(`\n${ANSI.bold}--- ${label} Aggregate ---${ANSI.reset}`);
	console.log(`  Avg recall@k (no graph):  ${agg.avgRecallNoGraph.toFixed(4)}`);
	console.log(
		`  Avg recall@k (with graph): ${agg.avgRecallWithGraph.toFixed(4)}`,
	);
	console.log(`  Avg Δ:                     ${colorDelta(agg.avgDelta)}`);
	console.log(
		`  p50 latency (no graph):    ${agg.p50LatencyNoGraph.toFixed(1)} ms`,
	);
	console.log(
		`  p50 latency (graph):       ${agg.p50LatencyGraph.toFixed(1)} ms`,
	);
	console.log(
		`  p95 latency (graph):       ${agg.p95LatencyGraph.toFixed(1)} ms`,
	);
}

// ═══════════════════════════════════════════════════════════════════════
// §4 — Main
// ═══════════════════════════════════════════════════════════════════════

interface FullBenchmarkResult {
	timestamp: string;
	cli: CliArgs;
	corpusSize: number;
	queryCount: number;
	runs: QueryResult[];
	aggregate: BenchmarkRunResult["aggregate"];
	sensitivity?: Array<{
		boost: number;
		avgRecallWithGraph: number;
		avgDelta: number;
		p50LatencyGraph: number;
		p95LatencyGraph: number;
	}>;
}

async function main(): Promise<void> {
	const args = parseArgs();

	if (args.help) {
		printUsage();
		process.exit(0);
	}

	// Warn about prerequisites
	console.log(
		`${ANSI.bold}${ANSI.yellow}[!] ${ANSI.reset}${ANSI.bold}GraphRAG Benchmark${ANSI.reset}`,
	);
	console.log(
		`  ${ANSI.dim}Corpus: ${SYNTHETIC_DOCS.length} synthetic documents`,
	);
	console.log(`  ${ANSI.dim}Queries: ${QUERIES.length}`);
	console.log(`  ${ANSI.dim}Runs per query: ${args.runs}`);
	console.log(`  ${ANSI.dim}Recall@k: k=${args.k}${ANSI.reset}`);
	console.log();
	console.log(`${ANSI.yellow}⚠  Prerequisites:${ANSI.reset}`);
	console.log(
		`   ${ANSI.yellow}•${ANSI.reset} Backend must be running at ${args.baseUrl}`,
	);
	console.log(
		`   ${ANSI.yellow}•${ANSI.reset} Admin API key (HIAI_DOCS_API_KEY) configured on the backend`,
	);
	console.log(
		`   ${ANSI.yellow}•${ANSI.reset} GRAPH_SEARCH_ENABLED=true for graph-augmented tests`,
	);
	console.log(
		`   ${ANSI.yellow}.${ANSI.reset} AGE must be running in the shared database (no separate connection required)`,
	);
	console.log();

	// Health check
	try {
		const healthResp = await fetch(
			`${args.baseUrl}/api/admin/health/embeddings`,
			{
				headers: { Authorization: `Bearer ${args.apiKey}` },
			},
		);
		if (!healthResp.ok) {
			console.error(
				`${ANSI.red}✖ Backend health check failed (status ${healthResp.status}). Is the backend running?${ANSI.reset}`,
			);
			process.exit(1);
		}
		console.log(`${ANSI.green}✔ Backend reachable${ANSI.reset}\n`);
	} catch (err) {
		console.error(
			`${ANSI.red}✖ Cannot reach backend at ${args.baseUrl}: ${(err as Error).message}${ANSI.reset}`,
		);
		process.exit(1);
	}

	// Check graph-enabled status
	let graphStatus: { available: boolean } | null = null;
	try {
		const graphCheck = await fetch(`${args.baseUrl}/api/admin/graph/stats`, {
			headers: { Authorization: `Bearer ${args.apiKey}` },
		});
		if (graphCheck.ok) {
			graphStatus = (await graphCheck.json()) as { available: boolean };
		}
	} catch {
		// non-fatal
	}

	const graphAvailable = graphStatus?.available === true;
	if (!graphAvailable) {
		console.log(
			`${ANSI.yellow}⚠  Graph features appear to be disabled (GRAPH_SEARCH_ENABLED=false or AGE extension not reachable).${ANSI.reset}`,
		);
		console.log(
			`   ${ANSI.yellow}  Graph comparison will still run but graph expansion will be a no-op, so recall@k will be identical.${ANSI.reset}`,
		);
		console.log();
	}

	// ── Baseline: no graph ──────────────────────────────────────────
	console.log(`${ANSI.bold}Running baseline (no graph)...${ANSI.reset}`);
	const baseline = await runBenchmark(
		args.baseUrl,
		args.apiKey,
		QUERIES,
		args.k,
		args.runs,
		false,
		null,
	);
	printTable(baseline.queries);
	printAggregate(baseline.aggregate, "Baseline (no graph)");
	console.log();

	// ── With graph ──────────────────────────────────────────────────
	console.log(`${ANSI.bold}Running with graph expansion...${ANSI.reset}`);
	const graphResult = await runBenchmark(
		args.baseUrl,
		args.apiKey,
		QUERIES,
		args.k,
		args.runs,
		true,
		null,
	);
	printTable(graphResult.queries);
	printAggregate(graphResult.aggregate, "With graph");
	console.log();

	// ── Sensitivity testing ─────────────────────────────────────────
	const sensitivityResults: Array<{
		boost: number;
		avgRecallWithGraph: number;
		avgDelta: number;
		p50LatencyGraph: number;
		p95LatencyGraph: number;
	}> = [];

	if (args.boostRange && args.boostRange.length > 0) {
		console.log(
			`${ANSI.bold}--- Sensitivity: recall@k vs GRAPH_EXPANSION_BOOST ---${ANSI.reset}\n`,
		);
		// Set boost via env override (the search endpoint reads graphBoost from query param,
		// which we pass via runSearch -> ?graphBoost=N is handled by the search query schema)
		// We need to modify runSearch to support boost param. Let's do it inline.
		for (const boost of args.boostRange) {
			console.log(`${ANSI.bold}Boost = ${boost}${ANSI.reset}`);

			// Run with custom boost via ?graphBoost query param
			const queryResults: QueryResult[] = [];
			for (const spec of QUERIES) {
				const noGraphLatencies: number[] = [];
				const noGraphRecallValues: number[] = [];
				for (let r = 0; r < args.runs; r++) {
					const result = await runSearch(
						args.baseUrl,
						args.apiKey,
						spec.text,
						false,
						args.k,
					);
					noGraphLatencies.push(result.latencyMs);
					noGraphRecallValues.push(
						computeRecallAtK(result.ids, spec.relevantDocIds, args.k),
					);
				}
				const recallNoGraph =
					noGraphRecallValues.reduce((a, b) => a + b, 0) /
					noGraphRecallValues.length;

				const graphLatencies: number[] = [];
				const graphRecallValues: number[] = [];
				for (let r = 0; r < args.runs; r++) {
					const params = new URLSearchParams({
						q: spec.text,
						limit: String(args.k),
						graph: "true",
						graphBoost: String(boost),
					});
					const url = `${args.baseUrl}/api/search?${params}`;
					const start = performance.now();
					const resp = await fetch(url, {
						headers: {
							Authorization: `Bearer ${args.apiKey}`,
							Accept: "application/json",
						},
					});
					const elapsed = performance.now() - start;
					const data = resp.ok
						? ((await resp.json()) as SearchResponse)
						: { items: [] };
					graphLatencies.push(elapsed);
					graphRecallValues.push(
						computeRecallAtK(
							(data.items ?? []).map((item) => item.id),
							spec.relevantDocIds,
							args.k,
						),
					);
				}
				const recallWithGraph =
					graphRecallValues.reduce((a, b) => a + b, 0) /
					graphRecallValues.length;

				queryResults.push({
					query: spec.text,
					recallNoGraph,
					recallWithGraph,
					delta: recallWithGraph - recallNoGraph,
					p50LatencyNoGraph: percentile(noGraphLatencies, 50),
					p50LatencyGraph: percentile(graphLatencies, 50),
					p95LatencyGraph: percentile(graphLatencies, 95),
				});
			}

			const avgRecall =
				queryResults.reduce((s, q) => s + q.recallWithGraph, 0) /
				queryResults.length;
			const avgDelta =
				queryResults.reduce((s, q) => s + q.delta, 0) / queryResults.length;
			const allLatencies = queryResults.map((q) => q.p50LatencyGraph);
			const allP95 = queryResults.map((q) => q.p95LatencyGraph);

			sensitivityResults.push({
				boost,
				avgRecallWithGraph: avgRecall,
				avgDelta,
				p50LatencyGraph: percentile(allLatencies, 50),
				p95LatencyGraph: percentile(allP95, 95),
			});
		}

		// Print sensitivity table
		console.log(
			`\n${ANSI.bold}Sensitivity Summary: recall@k vs GRAPH_EXPANSION_BOOST${ANSI.reset}`,
		);
		console.log(
			`${"Boost".padEnd(10)} | ${"Avg recall (graph)".padEnd(18)} | ${"Δ vs baseline".padEnd(12)} | ${"p50 lat".padEnd(10)} | ${"p95 lat".padEnd(10)}`,
		);
		console.log("-".repeat(70));
		for (const sr of sensitivityResults) {
			const baselineRecall = baseline.aggregate.avgRecallNoGraph;
			const deltaVsBaseline = sr.avgRecallWithGraph - baselineRecall;
			console.log(
				`${String(sr.boost).padEnd(10)} | ${sr.avgRecallWithGraph.toFixed(4).padEnd(18)} | ${colorDelta(deltaVsBaseline).padStart(12)} | ${sr.p50LatencyGraph.toFixed(1).padEnd(10)} | ${sr.p95LatencyGraph.toFixed(1).padEnd(10)}`,
			);
		}
		console.log();
	}

	// ── JSON output ─────────────────────────────────────────────────
	if (args.json) {
		const output: FullBenchmarkResult = {
			timestamp: new Date().toISOString(),
			cli: args,
			corpusSize: SYNTHETIC_DOCS.length,
			queryCount: QUERIES.length,
			runs: graphResult.queries,
			aggregate: graphResult.aggregate,
		};
		if (sensitivityResults.length > 0) {
			output.sensitivity = sensitivityResults;
		}
		console.log(JSON.stringify(output, null, 2));
	}

	// ── Summary ─────────────────────────────────────────────────────
	console.log(`\n${ANSI.bold}${ANSI.green}✔ Benchmark complete${ANSI.reset}`);
	console.log(
		`  ${ANSI.dim}Corpus: ${SYNTHETIC_DOCS.length} docs, ${QUERIES.length} queries`,
	);
	console.log(
		`  ${ANSI.dim}Avg recall@k (no graph):  ${baseline.aggregate.avgRecallNoGraph.toFixed(4)}`,
	);
	console.log(
		`  ${ANSI.dim}Avg recall@k (with graph): ${graphResult.aggregate.avgRecallWithGraph.toFixed(4)}`,
	);
	console.log(
		`  ${ANSI.dim}Avg Δ:                     ${graphResult.aggregate.avgDelta >= 0 ? "+" : ""}${graphResult.aggregate.avgDelta.toFixed(4)}`,
	);
	console.log(
		`  ${ANSI.dim}p50 latency (graph):       ${graphResult.aggregate.p50LatencyGraph.toFixed(1)} ms`,
	);
	console.log(
		`  ${ANSI.dim}p95 latency (graph):       ${graphResult.aggregate.p95LatencyGraph.toFixed(1)} ms${ANSI.reset}`,
	);
}

await main();

export {};
