import { expect, test } from 'bun:test';

import { validateReleaseVersion } from '../../../scripts/release-version-validator.ts';

test('release version validator accepts the synchronized release tag', async () => {
  await expect(validateReleaseVersion({ root: new URL('../../../', import.meta.url), tag: 'v0.8.2' }))
    .resolves.toBeUndefined();
});

test('release version validator rejects a tag that drifts from committed metadata', async () => {
  await expect(
    validateReleaseVersion({ root: new URL('../../../', import.meta.url), tag: 'v0.7.4' })
  ).rejects.toThrow('Release version mismatch');
});
