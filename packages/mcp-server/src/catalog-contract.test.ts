import { describe, expect, test } from 'bun:test';

import { capabilityCatalog } from './capabilities.js';

describe('DocsMint MCP catalog contract', () => {
  test('publishes the exact document manager, retrieval, graph, and indexing catalog', () => {
    expect(capabilityCatalog.tools).toEqual([
        'search_documents',
        'get_document',
        'create_document',
        'update_document',
        'list_documents',
        'list_folders',
        'create_folder',
        'create_snapshot',
        'get_version_history',
        'export_document',
        'list_categories',
        'create_category',
        'list_tags',
        'get_related_documents',
        'search_knowledge_graph',
        'get_document_index_status',
        'refresh_document_index',
    ]);
    expect(capabilityCatalog.tools).toHaveLength(17);
  });

  test('publishes prompts and resources for agent discovery', () => {
    expect(capabilityCatalog.prompts).toEqual(['organize_workspace', 'research_workspace']);
    expect(capabilityCatalog.prompts).toHaveLength(2);
    expect(capabilityCatalog.resources).toEqual([
      'docsmint://guide/editor',
      'docsmint://guide/search',
      'docsmint://workspace/catalog',
    ]);
    expect(capabilityCatalog.resources).toHaveLength(3);
  });

  test('ships the registry badge, three easy installs, license, and an agent skill', async () => {
    const root = new URL('../../../', import.meta.url);
    const readme = await Bun.file(new URL('README.md', root)).text();
    const mcpReadme = await Bun.file(new URL('packages/mcp-server/README.md', root)).text();
    const publishedPackage = await Bun.file(new URL('package.public.json', root)).json();
    const skill = Bun.file(new URL('skills/docsmint-document-manager/SKILL.md', root));

    expect(readme).toContain(
      '[![MCP Badge](https://lobehub.com/badge/mcp/hiai-gg-docsmint)](https://lobehub.com/mcp/hiai-gg-docsmint)',
    );
    expect(readme).toContain('## MCP Features');
    expect(readme).toContain('### Tools (17)');
    expect(readme).toContain('### Prompts (2)');
    expect(readme).toContain('### Resources (3)');
    expect(readme).toContain('`organize_workspace`');
    expect(readme).toContain('`research_workspace`');
    expect(readme).toContain('`docsmint://guide/editor`');
    expect(readme).toContain('`docsmint://guide/search`');
    expect(readme).toContain('`docsmint://workspace/catalog`');
    expect(readme).toContain('npx -y @hiai-gg/docsmint docsmint-mcp');
    expect(readme).toContain('"command": "npx"');
    expect(readme).toContain('"args": ["-y", "@hiai-gg/docsmint", "docsmint-mcp"]');
    expect(readme).toContain('### Skills (1)');
    expect(readme).toContain('skills/docsmint-document-manager/SKILL.md');
    expect(mcpReadme).toContain('"command": "npx"');
    expect(mcpReadme).toContain('### Bunx');
    expect(mcpReadme).toContain('### NPX');
    expect(mcpReadme).toContain('### Local checkout');
    expect(mcpReadme).toContain('## MCP Features');
    expect(await skill.exists()).toBe(true);
    expect(publishedPackage.files).toContain('skills');
    expect(publishedPackage.license).toBe('Apache-2.0');
    expect(await Bun.file(new URL('LICENSE', root)).text()).toContain('Apache License');
  });

  test('publishes one verified identity to the official MCP Registry', async () => {
    const root = new URL('../../../', import.meta.url);
    const publishedPackage = await Bun.file(new URL('package.public.json', root)).json();
    const registryManifest = await Bun.file(new URL('server.json', root)).json();

    expect(publishedPackage.mcpName).toBe('io.github.HiAi-gg/docsmint');
    expect(publishedPackage.files).toContain('server.json');
    expect(publishedPackage.exports['./mcp']).toEqual({
      import: './dist/mcp-server.js',
      types: './dist/mcp-server.d.ts',
    });
    expect(registryManifest).toMatchObject({
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      name: 'io.github.HiAi-gg/docsmint',
      version: publishedPackage.version,
      repository: {
        url: 'https://github.com/HiAi-gg/docsmint',
        source: 'github',
      },
      packages: [
        {
          registryType: 'npm',
          identifier: '@hiai-gg/docsmint',
          version: publishedPackage.version,
          transport: { type: 'stdio' },
        },
      ],
      remotes: [
        {
          type: 'streamable-http',
          url: 'https://docsmint.com/mcp',
        },
      ],
    });
  });

  test('uses the stable MCP v2 server packages for the current protocol', async () => {
    const root = new URL('../../../', import.meta.url);
    const packageJson = await Bun.file(new URL('packages/mcp-server/package.json', root)).json();
    const sources = await Promise.all(
      ['server.ts', 'capabilities.ts', 'index.ts', 'server.test.ts'].map((path) =>
        Bun.file(new URL(`packages/mcp-server/src/${path}`, root)).text()
      )
    );

    expect(packageJson.dependencies['@modelcontextprotocol/server']).toBe('2.0.0');
    expect(packageJson.devDependencies['@modelcontextprotocol/client']).toBe('2.0.0');
    expect(sources.join('\n')).not.toContain('@modelcontextprotocol/sdk');
  });

  test('publishes the official registry manifest only after the complete release gate', async () => {
    const root = new URL('../../../', import.meta.url);
    const workflow = await Bun.file(new URL('.github/workflows/ci.yml', root)).text();

    expect(workflow).toContain('publish-mcp-registry:');
    expect(workflow).toContain('release-static-gates:');
    expect(workflow).toContain('run: bun run release:check:contract-evidence');
    expect(workflow).toContain('needs: [publish-npm]');
		expect(workflow).toContain('verify-npm-provenance:');
		expect(workflow).toContain('needs: [verify-npm-provenance]');
		expect(workflow).toContain('bun run scripts/verify-published-package.ts');
    expect(workflow).toContain('mcp-publisher login github-oidc');
    expect(workflow).toContain('mcp-publisher publish');
    expect(workflow).toContain(
			'needs: [publish-docker, verify-npm-provenance, publish-mcp-registry]'
    );
    expect(workflow).toContain('release-tag-gate:');
    expect(workflow).toContain('needs: [release-tag-gate]');
  });
});
