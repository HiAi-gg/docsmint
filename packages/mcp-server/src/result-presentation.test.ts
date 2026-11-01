import { expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { DocsClient } from "@hiai-docs/sdk";
import { createDocsmintMcpServer } from "./server.js";

test("text is a compact copy of the validated structured result", async () => {
  const docsClient = new DocsClient({ baseUrl: "https://example.invalid", retries: 1,
    fetch: (async () => Response.json([])) as unknown as typeof fetch });
  const server = createDocsmintMcpServer({ docsClient });
  const client = new Client({ name: "presentation-regression", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    const result = await client.callTool({ name: "list_workspace_structure", arguments: { kind: "categories" } });
    expect(result.structuredContent).toEqual({ operation: "categories", result: [] });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
  } finally { await client.close(); await server.close(); }
});

test("trusted host presentation is validated and serialized once", async () => {
  const docsClient = new DocsClient({baseUrl:"https://example.invalid", retries:1, fetch:(async()=>Response.json([])) as unknown as typeof fetch});
  const server = createDocsmintMcpServer({docsClient, decorateResult: (_tool, value) => ({...(value as object), presentation:"host"})});
  const client = new Client({name:"host-presentation",version:"1"});
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b),client.connect(a)]);
    const result = await client.callTool({name:"list_workspace_structure",arguments:{kind:"categories"}});
    expect(result.structuredContent).toMatchObject({operation:"categories",result:[]});
    expect(result.content).toEqual([{type:"text",text:JSON.stringify(result.structuredContent)}]);
  } finally { await client.close(); await server.close(); }
});

test("host document links survive validation while invalid host output is rejected", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  for (const valid of [true, false]) {
    const doc = {id,ownerId:id,folderId:null,categoryId:null,title:"Title",content:"Text",visibility:"private",createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z"};
    const docsClient = new DocsClient({baseUrl:"https://example.invalid",retries:1,fetch:(async()=>Response.json(doc)) as unknown as typeof fetch});
    const server = createDocsmintMcpServer({docsClient,decorateResult:(_tool,value)=>valid ? {...(value as object),result:{...doc,workspaceSlug:"family",url:"https://cloud.invalid/w/family/documents/"+id}} : {operation:"invalid"}});
    const client = new Client({name:"document-presentation",version:"1"});
    const [a,b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(b),client.connect(a)]);
      const result = await client.callTool({name:"read_document",arguments:{view:"detail",id}});
      if (valid) {
        expect(result.structuredContent).toMatchObject({operation:"detail",result:{id,content:"Text",workspaceSlug:"family",url:"https://cloud.invalid/w/family/documents/"+id}});
        expect(result.content).toEqual([{type:"text",text:JSON.stringify(result.structuredContent)}]);
      } else expect(result.isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  }
});
