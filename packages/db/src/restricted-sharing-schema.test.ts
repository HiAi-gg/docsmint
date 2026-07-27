import { describe, expect, test } from 'bun:test';
import { guestAccess, shareLinks } from './schema';

describe('restricted sharing schema', () => {
  test('stores explicit policy and per-recipient roles', () => {
    expect(shareLinks.accessMode.name).toBe('access_mode');
    expect(shareLinks.allowPasswordFallback.name).toBe('allow_password_fallback');
    expect(shareLinks.policyVersion.name).toBe('policy_version');
    expect(guestAccess.role.name).toBe('role');
    expect(guestAccess.status.name).toBe('status');
  });
});
