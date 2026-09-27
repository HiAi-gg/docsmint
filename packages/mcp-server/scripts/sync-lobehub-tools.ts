import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createDocsmintMcpServer } from '../src/server.js';

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createDocsmintMcpServer();
const client = new Client({ name: 'catalog-generator', version: '1' });
try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = (await client.listTools()).tools;
  const path = new URL('../../../lhm.plugin.json', import.meta.url);
  const manifest = await Bun.file(path).json();
  manifest.tools = tools.map(({ name, description, inputSchema, outputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    outputSchema,
    annotations,
  }));
  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Synchronized ${tools.length} LobeHub MCP tools`);
} finally {
  await client.close();
  await server.close();
}
