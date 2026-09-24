import { describe, expect, test } from 'bun:test';

import { capabilityCatalog } from './capabilities.js';

describe('DocsMint MCP catalog contract', () => {
  test('keeps the canonical catalog unique and documented', async () => {
    const root = new URL('../../../', import.meta.url);
    const readme = await Bun.file(new URL('README.md', root)).text();
    const mcpReadme = await Bun.file(new URL('packages/mcp-server/README.md', root)).text();
    const listedToolsSection = mcpReadme.split('### Tools\n')[1]?.split('\n### Lifecycle permissions')[0] ?? '';
    const readmeToolNames = [...listedToolsSection.matchAll(/^- `([^`]+)`:/gm)].map((match) => match[1]);

    expect(new Set(capabilityCatalog.tools).size).toBe(capabilityCatalog.tools.length);
    expect(new Set(capabilityCatalog.prompts).size).toBe(capabilityCatalog.prompts.length);
    expect(new Set(capabilityCatalog.resources).size).toBe(capabilityCatalog.resources.length);
    expect(readmeToolNames).toEqual([...capabilityCatalog.tools]);
    expect(mcpReadme).toContain('https://docsmint.com/mcp/connect');
    expect(readme).toContain('https://docsmint.com/mcp/connect');
    expect(mcpReadme).not.toContain('CIMD is not part of');
    expect(readme).not.toContain('CIMD is not part of');
  });

  test('keeps package and official Registry catalog metadata derived from the capability catalog', async () => {
    const root = new URL('../../../', import.meta.url);
    const publishedPackage = await Bun.file(new URL('package.public.json', root)).json();
    const registryManifest = await Bun.file(new URL('server.json', root)).json();
    const registryCatalog = registryManifest._meta['io.modelcontextprotocol.registry/publisher-provided'].catalog;

    expect(publishedPackage.mcpName).toBe('io.github.HiAi-gg/docsmint');
    expect(publishedPackage.files).toContain('server.json');
    expect(registryManifest).toMatchObject({
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      name: 'io.github.HiAi-gg/docsmint',
      version: publishedPackage.version,
      websiteUrl: 'https://docsmint.com/mcp/connect?source=mcp_registry',
      repository: {
        url: 'https://github.com/HiAi-gg/docsmint',
        source: 'github',
        subfolder: 'packages/mcp-server',
      },
    });
    expect(registryCatalog).toEqual({
      tools: capabilityCatalog.tools.length,
      prompts: capabilityCatalog.prompts.length,
      resources: capabilityCatalog.resources.length,
    });

    const cloudAuthDescription = registryManifest.remotes[0].headers.find(
      (header: { name: string }) => header.name === 'Authorization'
    ).description;
    expect(cloudAuthDescription).toContain('https://docsmint.com/mcp/connect');
    expect(cloudAuthDescription).not.toContain('CIMD is not part of');
    expect(cloudAuthDescription).not.toContain('DCR at https://');
  });

  test('keeps LobeHub tool declarations and category outputs aligned with the runtime catalog', async () => {
    const root = new URL('../../../', import.meta.url);
    const publishedPackage = await Bun.file(new URL('package.public.json', root)).json();
    const lobeHubManifest = await Bun.file(new URL('lhm.plugin.json', root)).json();

    expect(lobeHubManifest).toMatchObject({
      identifier: 'hiai-gg-docsmint',
      name: 'DocsMint',
      version: publishedPackage.version,
      cloudEndpoint: 'https://docsmint.com/mcp',
      homepage: 'https://docsmint.com/mcp/connect?source=lobehub_mcp',
    });
    expect(lobeHubManifest.tools.map((tool: { name: string }) => tool.name)).toEqual([
      ...capabilityCatalog.tools,
    ]);
    expect(lobeHubManifest.prompts.map((prompt: { name: string }) => prompt.name)).toEqual([
      ...capabilityCatalog.prompts,
    ]);
    expect(lobeHubManifest.resources.map((resource: { uri: string }) => resource.uri)).toEqual([
      ...capabilityCatalog.resources,
    ]);

    const categories = lobeHubManifest.tools.find((tool: { name: string }) => tool.name === 'list_categories');
    const categoryVariants = categories.outputSchema.properties.result.items.anyOf;
    const accessFields = ['apiMode', 'apiPermissionRead', 'apiPermissionEdit', 'apiPermissionWrite'];
    expect(categoryVariants).toHaveLength(2);
    expect(categoryVariants.some((variant: { required: string[] }) =>
      accessFields.every((field) => variant.required.includes(field))
    )).toBe(true);
    expect(categoryVariants.some((variant: { required: string[] }) =>
      accessFields.every((field) => !variant.required.includes(field))
    )).toBe(true);

    const summary = lobeHubManifest.localizations[0].summary;
    expect(summary).toContain('https://docsmint.com/mcp/connect');
    expect(summary).not.toContain('CIMD is not part of');
  });

  test('keeps the README linked to the published stdio package and skill', async () => {
    const root = new URL('../../../', import.meta.url);
    const readme = await Bun.file(new URL('README.md', root)).text();
    const mcpReadme = await Bun.file(new URL('packages/mcp-server/README.md', root)).text();
    const publishedPackage = await Bun.file(new URL('package.public.json', root)).json();
    const skill = Bun.file(new URL('skills/docsmint-document-manager/SKILL.md', root));

    expect(readme).toContain('[![MCP Badge](https://lobehub.com/badge/mcp/hiai-gg-docsmint)](https://lobehub.com/mcp/hiai-gg-docsmint)');
    expect(readme.match(/^## What's new/gm)).toHaveLength(1);
    expect(readme).not.toContain("## What's new in 0.7.");
    expect(readme).not.toContain('## MCP Features');
    expect(readme).toContain('[complete MCP reference](https://github.com/HiAi-gg/docsmint/blob/main/packages/mcp-server/README.md)');
    expect(readme).toContain('"command": "npx"');
    expect(readme).toContain('"args": ["--yes", "--package", "@hiai-gg/docsmint", "docsmint-mcp"]');
    expect(publishedPackage.description).toContain('self-hosted MCP stdio bridge');
    expect(mcpReadme).toContain('## MCP Features');
    expect(await skill.exists()).toBe(true);
    expect(publishedPackage.files).toContain('skills');
    expect(publishedPackage.license).toBe('Apache-2.0');
    expect(await Bun.file(new URL('LICENSE', root)).text()).toContain('Apache License');
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

  test('publishes the official Registry manifest only after the complete release gate', async () => {
    const root = new URL('../../../', import.meta.url);
    const workflow = await Bun.file(new URL('.github/workflows/ci.yml', root)).text();
    const manualRegistryWorkflow = await Bun.file(
      new URL('.github/workflows/publish-mcp-registry.yml', root)
    ).text();

    expect(workflow).toContain('publish-mcp-registry:');
    expect(workflow).toContain('release-static-gates:');
    expect(workflow).toContain('run: bun run release:check:contract-evidence');
    expect(workflow).toContain('needs: [publish-npm]');
    expect(workflow).toContain('verify-npm-provenance:');
    expect(workflow).toContain('needs: [verify-npm-provenance]');
    expect(workflow).toContain('bun run scripts/verify-published-package.ts');
    expect(workflow).toContain('bun run scripts/validate-mcp-catalog.ts');
    expect(manualRegistryWorkflow).toContain('bun run scripts/validate-mcp-catalog.ts');
    expect(workflow).toContain('mcp-publisher login github-oidc');
    expect(workflow).toContain('mcp-publisher publish');
    expect(workflow).toContain('release-tag-gate:');
    expect(workflow).toContain('needs: [release-tag-gate]');
  });
});
