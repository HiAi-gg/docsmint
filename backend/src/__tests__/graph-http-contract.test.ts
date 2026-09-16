import { expect, test } from "bun:test";

// Keep route dependency mocks in a subprocess so the full suite cannot inherit them.
test("graph routes enforce limits after authorization and reject unauthorized seeds before traversal", async () => {
	const script = `
 import { expect, mock } from "bun:test";
 import { PgDialect } from "drizzle-orm/pg-core";
 let summaryQuery;
 const base = ${JSON.stringify(import.meta.dir)};
 let expansions = 0;
 let failGraph = false;
 const allowed = new Set(["seed", "b", "c"]);
 mock.module(base + "/../lib/config", () => ({ config: { GRAPH_SEARCH_ENABLED: true } }));
 mock.module(base + "/../lib/logger", () => ({ logger: { warn() {} } }));
 mock.module(base + "/../lib/content-access", () => ({
  resolveContentAccess: async () => ({ principal: {kind: "session"}, ctx: {}, permissions: new Set(["read"]), restricted: false }),
  canAccessContent: () => true,
  tenantOwnerSql: () => "true",
  tenantOwnerCondition: () => undefined,
  effectiveDocumentCategorySql: () => "true",
 }));
 mock.module(base + "/../api/middleware/rate-limit", () => ({ searchRateLimiter: async () => ({allowed:true}), rateLimitHeaders: () => ({}) }));
 mock.module(base + "/../lib/graph/init", () => ({ getGraphDb: async () => ({unsafe: async () => []}) }));
 mock.module(base + "/../lib/graph/search-expansion", () => ({ expandResults: async () => {
  expansions++;
  if (failGraph) throw new Error("AGE unavailable");
  return new Map([["seed", ["a-foreign", "b", "c"].map(docId => ({docId, seedGenerationId:"g", generationId:"g", relationType:"MENTIONS", hopDistance:1}))]]);
 } }));
 mock.module(base + "/../lib/with-tenant", () => ({ withTenant: async (_ctx, fn) => fn({
  execute: async query => {
   const rendered = new PgDialect().sqlToQuery(query);
   if (rendered.sql.includes("d.content")) {
    summaryQuery = rendered;
    return [{id:"c",title:"Cats",content:"cat"},{id:"b",title:"Platform",content:"cats"}];
   }
   return [...allowed].map(id => ({id}));
  },
  select: () => ({from: () => ({where: async () => ["seed", "a-foreign", "b", "c"].map(id => ({id, generationId:"g"}))})}),
 }) }));
 const {graphRoutes} = await import(base + "/../api/routes/graph");
 async function get(path) { return graphRoutes.handle(new Request("http://localhost" + path)); }
 let response = await get("/api/graph/related/seed?limit=1");
 expect(response.status).toBe(200);
 expect((await response.json()).related.map(x => x.docId)).toEqual(["b"]);
 response = await get("/api/graph/related/seed?limit=2");
 expect((await response.json()).related.map(x => x.docId)).toEqual(["b", "c"]);
 for (const limit of ["0", "101", "1.5", "nope"]) expect((await get("/api/graph/related/seed?limit=" + limit)).status).toBe(400);
 const before = expansions;
 expect((await get("/api/graph/related/foreign?limit=1")).status).toBe(404);
 response = await graphRoutes.handle(new Request("http://localhost/api/graph/search", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({query:"cats", docIds:["seed", "foreign"]})}));
 expect(response.status).toBe(404);
 expect(expansions).toBe(before);
 response = await graphRoutes.handle(new Request("http://localhost/api/graph/search", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({query:"cats", docIds:["seed"], maxResults:1})}));
 expect(response.status).toBe(200);
 expect((await response.json()).relatedDocs.map(x => x.docId)).toEqual(["c"]);
 expect(summaryQuery.params).toContain("cats");
 expect(summaryQuery.params).not.toContain("a-foreign");
 failGraph = true;
 response = await get("/api/graph/related/seed?limit=1");
 expect(response.status).toBe(200);
 expect((await response.json()).related).toEqual([]);
 `;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
