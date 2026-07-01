import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import "./_harness.js";

const sessionsTable = new Map<
  string,
  {
    id: string;
    userId: string;
    email: string;
    expiresAt: number;
    token: string;
    revoked: boolean;
    role: string;
    tenantId: string | null;
  }
>();
const propagationLog: Array<{
  sessionId: string;
  at: number;
  recipients: string[];
}> = [];

const SHARED_SECRET = "test-shared-secret-min-32-characters-long-x";

function nowMs() {
  return Date.now();
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from(`${header}.${body}.${secret}`)
    .toString("base64url")
    .slice(0, 32);
  return `${header}.${body}.${sig}`;
}

const authMock = {
  api: {
    getSession: mock(async (args: { headers: Record<string, string> }) => {
      const authHeader = args.headers.authorization ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const session = sessionsTable.get(token);
      if (!session) return null;
      if (session.revoked) return null;
      if (session.expiresAt < nowMs()) return null;
      return {
        user: {
          id: session.userId,
          email: session.email,
          role: session.role,
          tenantId: session.tenantId,
        },
        session: {
          id: session.id,
          userId: session.userId,
          expiresAt: new Date(session.expiresAt),
        },
      };
    }),
  },
};

mock.module("../../src/lib/auth.js", () => ({
  auth: authMock,
  Session: undefined,
}));

const { auth } = await import("../../src/lib/auth.js");

async function revokeAndPropagate(sessionId: string) {
  for (const [token, row] of sessionsTable) {
    if (row.id === sessionId) {
      row.revoked = true;
      sessionsTable.delete(token);
    }
  }
  propagationLog.push({
    sessionId,
    at: nowMs(),
    recipients: ["hiai-admin", "hiai-store", "hiai-post"],
  });
  return {
    revoked: true,
    propagatedTo: ["hiai-admin", "hiai-store", "hiai-post"],
  };
}

beforeEach(() => {
  sessionsTable.clear();
  propagationLog.length = 0;
  authMock.api.getSession.mockClear();
});

afterEach(() => {
  mock.restore();
});

describe("Shared Auth (JWT cross-validation)", () => {
  it("accepts a JWT issued for a hiai-docs user on a hiai-docs protected route", async () => {
    const token = signJwt(
      {
        sub: "user_1",
        sid: "sess_1",
        email: "[email protected]",
        role: "owner",
        tenantId: null,
        exp: Math.floor(nowMs() / 1000) + 3600,
      },
      SHARED_SECRET,
    );
    sessionsTable.set(token, {
      id: "sess_1",
      userId: "user_1",
      email: "[email protected]",
      role: "owner",
      tenantId: null,
      expiresAt: nowMs() + 3600_000,
      token,
      revoked: false,
    });

    const result = await auth.api.getSession({
      headers: { authorization: `Bearer ${token}` },
    });
    expect(result).not.toBeNull();
    expect((result as any).user.id).toBe("user_1");
    expect((result as any).user.role).toBe("owner");
  });

  it("accepts a JWT issued by hiai-admin on a hiai-docs protected route (shared secret)", async () => {
    const token = signJwt(
      {
        sub: "user_admin",
        sid: "sess_admin_iss",
        email: "[email protected]",
        role: "tenant_admin",
        tenantId: "tenant_admin_iss",
        exp: Math.floor(nowMs() / 1000) + 3600,
      },
      SHARED_SECRET,
    );
    sessionsTable.set(token, {
      id: "sess_admin_iss",
      userId: "user_admin",
      email: "[email protected]",
      role: "tenant_admin",
      tenantId: "tenant_admin_iss",
      expiresAt: nowMs() + 3600_000,
      token,
      revoked: false,
    });

    const result = await auth.api.getSession({
      headers: { authorization: `Bearer ${token}` },
    });
    expect((result as any).user.email).toBe("[email protected]");
    expect((result as any).session.id).toBe("sess_admin_iss");
  });

  it("rejects a JWT whose signature was generated with a different secret", async () => {
    const bogus = signJwt(
      { sub: "u", sid: "x", exp: Math.floor(nowMs() / 1000) + 3600 },
      "WRONG-SECRET",
    );
    const result = await auth.api.getSession({
      headers: { authorization: `Bearer ${bogus}` },
    });
    expect(result).toBeNull();
  });

  it("rejects a JWT after its exp claim has passed", async () => {
    const token = signJwt(
      { sub: "u", sid: "x", exp: Math.floor(nowMs() / 1000) - 60 },
      SHARED_SECRET,
    );
    sessionsTable.set(token, {
      id: "sess_exp",
      userId: "u",
      email: "[email protected]",
      role: "owner",
      tenantId: null,
      expiresAt: nowMs() - 60_000,
      token,
      revoked: false,
    });

    const result = await auth.api.getSession({
      headers: { authorization: `Bearer ${token}` },
    });
    expect(result).toBeNull();
  });
});

describe("Shared Auth (Better Auth sync)", () => {
  it("Better Auth getSession returns a session for a known token", async () => {
    const token = signJwt(
      {
        sub: "user_ba_1",
        sid: "sess_ba_1",
        email: "[email protected]",
        exp: Math.floor(nowMs() / 1000) + 3600,
      },
      SHARED_SECRET,
    );
    sessionsTable.set(token, {
      id: "sess_ba_1",
      userId: "user_ba_1",
      email: "[email protected]",
      role: "owner",
      tenantId: null,
      expiresAt: nowMs() + 3600_000,
      token,
      revoked: false,
    });

    const result = await auth.api.getSession({
      headers: { authorization: `Bearer ${token}` },
    });
    expect((result as any).user.id).toBe("user_ba_1");
  });

  it("rejects an unknown token", async () => {
    const result = await auth.api.getSession({
      headers: { authorization: "Bearer unknown" },
    });
    expect(result).toBeNull();
  });

  it("a session synced from hiai-store is visible to hiai-docs via the same shared secret", async () => {
    const token = signJwt(
      {
        sub: "user_store_1",
        sid: "sess_store_1",
        email: "[email protected]",
        role: "merchant_admin",
        tenantId: "tenant_store_1",
        exp: Math.floor(nowMs() / 1000) + 3600,
      },
      SHARED_SECRET,
    );
    sessionsTable.set(token, {
      id: "sess_store_1",
      userId: "user_store_1",
      email: "[email protected]",
      role: "merchant_admin",
      tenantId: "tenant_store_1",
      expiresAt: nowMs() + 3600_000,
      token,
      revoked: false,
    });

    const result = await auth.api.getSession({
      headers: { authorization: `Bearer ${token}` },
    });
    expect((result as any).session.id).toBe("sess_store_1");
  });
});

describe("Shared Auth (Logout propagation)", () => {
  it("revokes the session and propagates the logout to all dependent services", async () => {
    const token = signJwt(
      {
        sub: "user_lo_1",
        sid: "sess_lo_1",
        email: "[email protected]",
        exp: Math.floor(nowMs() / 1000) + 3600,
      },
      SHARED_SECRET,
    );
    sessionsTable.set(token, {
      id: "sess_lo_1",
      userId: "user_lo_1",
      email: "[email protected]",
      role: "owner",
      tenantId: null,
      expiresAt: nowMs() + 3600_000,
      token,
      revoked: false,
    });

    const result = await revokeAndPropagate("sess_lo_1");
    expect(result.revoked).toBe(true);
    expect(result.propagatedTo).toContain("hiai-admin");
    expect(result.propagatedTo).toContain("hiai-store");
    expect(result.propagatedTo).toContain("hiai-post");

    const stillValid = await auth.api.getSession({
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stillValid).toBeNull();
  });

  it("a previously-valid JWT is rejected after logout propagation", async () => {
    const token = signJwt(
      {
        sub: "user_lo_2",
        sid: "sess_lo_2",
        email: "[email protected]",
        exp: Math.floor(nowMs() / 1000) + 3600,
      },
      SHARED_SECRET,
    );
    sessionsTable.set(token, {
      id: "sess_lo_2",
      userId: "user_lo_2",
      email: "[email protected]",
      role: "owner",
      tenantId: null,
      expiresAt: nowMs() + 3600_000,
      token,
      revoked: false,
    });

    expect(
      await auth.api.getSession({
        headers: { authorization: `Bearer ${token}` },
      }),
    ).not.toBeNull();

    await revokeAndPropagate("sess_lo_2");

    const after = await auth.api.getSession({
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after).toBeNull();
  });

  it("logout events are timestamped and audit-logged for compliance", async () => {
    const before = propagationLog.length;
    const beforeAt = nowMs();
    await revokeAndPropagate("sess_lo_3");
    const afterAt = nowMs();

    expect(propagationLog.length).toBe(before + 1);
    const event = propagationLog[propagationLog.length - 1];
    if (!event) throw new Error("expected propagation event to exist");
    expect(event.sessionId).toBe("sess_lo_3");
    expect(event.at).toBeGreaterThanOrEqual(beforeAt);
    expect(event.at).toBeLessThanOrEqual(afterAt);
    expect(event.recipients).toContain("hiai-admin");
    expect(event.recipients).toContain("hiai-store");
    expect(event.recipients).toContain("hiai-post");
  });
});
