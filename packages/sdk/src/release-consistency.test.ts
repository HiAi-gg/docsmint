import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const repositoryRoot = new URL('../../../', import.meta.url);
const releaseVersion = '0.7.3';

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(path, repositoryRoot), 'utf8'));
}

test('all published and workspace release metadata reports 0.7.3', async () => {
  for (const path of [
    'package.json',
    'package.public.json',
    'backend/package.json',
    'frontend/package.json',
    'packages/cli/package.json',
    'packages/db/package.json',
    'packages/mcp-server/package.json',
    'packages/sdk/package.json',
  ]) {
    expect((await json(path)).version, path).toBe(releaseVersion);
  }

  const lockfile = Bun.JSONC.parse(
    await readFile(new URL('bun.lock', repositoryRoot), 'utf8')
  ) as { workspaces: Record<string, { version?: string }> };
  for (const path of [
    'backend',
    'frontend',
    'packages/cli',
    'packages/db',
    'packages/mcp-server',
    'packages/sdk',
  ]) {
    expect(lockfile.workspaces[path]?.version, `bun.lock workspace ${path}`).toBe(releaseVersion);
  }

  const frontendManifest = await json('frontend/package.json');
  expect((frontendManifest.dependencies as Record<string, string>)['lucide-svelte']).toBe(
    '^0.577.0'
  );

  const publicManifest = await json('package.public.json');
  expect(publicManifest.name).toBe('@hiai-gg/docsmint');
  const publicExports = publicManifest.exports as Record<string, Record<string, string>>;
  expect(publicExports['./mcp']).toEqual({
    import: './dist/mcp-server.js',
    types: './dist/mcp-server.d.ts',
  });
  expect((publicManifest.bin as Record<string, string>)['docsmint-mcp']).toBe(
    './dist/mcp-cli.js'
  );
  expect((publicManifest.bin as Record<string, string>)['hiai-docs-mcp']).toBe(
    './dist/mcp-cli.js'
  );
  expect(publicExports['./backend/launcher']).toEqual({
    browser: './dist/server-only-browser-entry.js',
    import: './dist/backend-launcher.js',
    types: './dist/backend-launcher.d.ts',
  });
  expect(publicExports['./storage-quota']).toEqual({
    browser: './dist/server-only-browser-entry.js',
    import: './dist/storage-quota.js',
    types: './dist/storage-quota.d.ts',
  });
  expect(publicExports['./backend/lib/api-key-facade']).toEqual({
    import: './dist/backend-api-key-facade.js',
    types: './backend/src/lib/api-key-facade.ts',
  });
  expect(publicExports['./lifecycle/runtime']).toEqual({
    browser: './dist/server-only-browser-entry.js',
    import: './dist/lifecycle-runtime.js',
    types: './dist/lifecycle-runtime.d.ts',
  });
  expect(publicExports['./pipeline/cancellation']).toEqual({
    browser: './dist/server-only-browser-entry.js',
    import: './dist/pipeline-cancellation.js',
    types: './dist/pipeline-cancellation.d.ts',
  });
  expect(publicExports['./backend/account-runtime-cleanup']).toEqual({
    browser: './dist/server-only-browser-entry.js',
    import: './dist/backend-account-runtime-cleanup.js',
    types: './dist/backend-account-runtime-cleanup.d.ts',
  });
  expect((publicManifest.dependencies as Record<string, string>).ioredis).toBe('^5.11.1');
  expect(publicExports['./frontend/styles.css']).toBe('./dist/frontend/frontend.css');
  const appShellDeclarationWriter = await readFile(
    new URL('packages/sdk/scripts/write-frontend-declarations.ts', repositoryRoot),
    'utf8'
  );
  expect(appShellDeclarationWriter).toContain('DocsmintRequestAdapter');
  expect(appShellDeclarationWriter).toContain('DocsmintRealtimeAdapter');
  expect(appShellDeclarationWriter).toContain('getDocsmintRealtimeAdapter');
  expect(appShellDeclarationWriter).toContain('getDocsmintRequestAdapter');
  expect(appShellDeclarationWriter).toContain('getDocsmintShareAdapter');
  expect(appShellDeclarationWriter).toContain('share?: DocsmintShareAdapter');
  expect(appShellDeclarationWriter).toContain('options?: DocsmintNavigationOptions');
  const openApi = await json('docs/openapi.json');
  expect((openApi.info as { version: string }).version).toBe(releaseVersion);
  const registryManifest = await json('server.json');
  expect(registryManifest.version).toBe(releaseVersion);
  expect(((registryManifest.packages as Array<{ version: string }>)[0]).version).toBe(releaseVersion);

  for (const path of [
    'backend/src/index.ts',
    'packages/cli/src/index.ts',
    'packages/mcp-server/src/server.ts',
  ]) {
    expect(await readFile(new URL(path, repositoryRoot), 'utf8'), path).toContain(releaseVersion);
  }

  expect(await readFile(new URL('frontend/vite.config.ts', repositoryRoot), 'utf8')).toContain(
    'docsmint-oss-0.7.3'
  );
  expect(await readFile(new URL('docker-compose.yml', repositoryRoot), 'utf8')).toContain(
    'docsmint-oss-0.7.3'
  );
});

test('workspace and public package metadata share the 0.7.3 product identity', async () => {
  const workspaceManifest = await json('package.json');
  const publicManifest = await json('package.public.json');
  const description =
    'Self-hosted AI-native knowledge workspace and installable PWA with hybrid search, GraphRAG, REST, SDK, CLI, and MCP access for people and AI agents.';
  const repository = {
    type: 'git',
    url: 'https://github.com/HiAi-gg/docsmint',
  };
  const bugs = { url: 'https://github.com/hiai-gg/docsmint/issues' };
  const requiredKeywords = [
    'ai-agents',
    'graphrag',
    'knowledge-management',
    'mcp',
    'progressive-web-app',
    'pwa',
  ];

  for (const manifest of [workspaceManifest, publicManifest]) {
    expect(manifest.description).toBe(description);
    expect(manifest.license).toBe('Apache-2.0');
    expect(manifest.repository).toEqual(repository);
    expect(manifest.homepage).toBe('https://github.com/hiai-gg/docsmint#readme');
    expect(manifest.bugs).toEqual(bugs);
    for (const keyword of requiredKeywords) {
      expect(manifest.keywords as string[]).toContain(keyword);
    }
  }

  expect(workspaceManifest.description).toBe(publicManifest.description);
  expect(workspaceManifest.keywords).toEqual(publicManifest.keywords);
});
