import { describe, expect, it } from "vitest";
import {
  KamiwazaError,
  REQUIRED_IDENTITY_HEADERS,
  SECRET_IDENTITY_HEADERS,
  SIGNED_IDENTITY_HEADERS,
  redactSecrets,
} from "../../src/platform/index.ts";
import { assertCallerHeaders, buildForwardAuthHeaders, extractSignedIdentity } from "../../src/platform/forward-auth.ts";
import { extractErrorDetail } from "../../src/platform/errors.ts";
import { CapabilityRegistry } from "../../src/platform/capabilities.ts";

describe("buildForwardAuthHeaders", () => {
  it("sets the gateway headers exactly and omits the workroom hint when absent", () => {
    const h = buildForwardAuthHeaders({ token: "tok-123456", method: "POST", uri: "/api/auth/check", host: "kamiwaza.example", proto: "https" });
    expect(h).toEqual({
      accept: "application/json",
      authorization: "Bearer tok-123456",
      "x-forwarded-method": "POST",
      "x-forwarded-uri": "/api/auth/check",
      "x-forwarded-host": "kamiwaza.example",
      "x-forwarded-proto": "https",
    });
    expect(buildForwardAuthHeaders({ token: "t", method: "GET", uri: "/api/x", host: "h", proto: "https", workroomId: "" })["x-workroom-id"]).toBeUndefined();
    expect(buildForwardAuthHeaders({ token: "t", method: "GET", uri: "/api/x", host: "h", proto: "https", workroomId: "w1" })["x-workroom-id"]).toBe("w1");
  });
});

describe("extractSignedIdentity", () => {
  it("copies allowlisted headers byte-for-byte and derives public identity", () => {
    const headers = new Headers({
      "X-User-Id": "u1",
      "X-User-Name": "Finn N",
      "X-User-Roles": " admin ,authenticated,, ",
      "X-Workroom-Id": "w1",
      "X-User-Workroom-Role": "editor",
      "X-User-Signature": "  sig with spaces  ",
      "X-User-Signature-Stable": "stable",
      "X-User-Signature-Ts": "1757740000",
      "X-Auth-Token": "tok",
      "X-User-Email": "signed@example.com",
      "X-User-Groups": "group-a",
      "X-User-Attributes-Hash": "signed-attribute-hash",
      "X-User-Preferred-Username": "native-user",
      "X-User-System-High": "false",
      "X-Auth-Azp": "kamiwaza",
      "X-User-Workroom-Id": "w1",
      "X-Requested-Workroom-Scope": "w1",
      "X-Verified-Workroom-Scope": "w1",
      "X-Protected-Action-Type": "read",
      "X-Visibility-Scope": "workroom",
      "X-Authz-Outcome": "allow",
      "X-Authz-Reason-Class": "authorized",
      "X-Untrusted-Debug": "must-not-forward",
    });
    const result = extractSignedIdentity(headers);
    expect(result.identity).toEqual({ userId: "u1", userName: "Finn N", roles: ["admin", "authenticated"], workroomId: "w1", workroomRole: "editor" });
    expect(result.signatureTs).toBe("1757740000");
    for (const [name, value] of headers) {
      if (name !== 'x-untrusted-debug') expect(result.forwardHeaders[name]).toBe(value);
    }
    expect(result.forwardHeaders['x-untrusted-debug']).toBeUndefined();
    expect(result.forwardHeaders["x-user-signature"]).toBe("sig with spaces");
    expect(result.forwardHeaders["x-user-roles"]).toBe(" admin ,authenticated,, ".trim());
    expect(Object.isFrozen(result.forwardHeaders)).toBe(true);
    expect(JSON.stringify(result.identity)).not.toContain("sig");
  });

  it("throws missing_signature when a required header is absent or empty", () => {
    for (const name of REQUIRED_IDENTITY_HEADERS) {
      const h = new Headers({ "x-user-id": "u1", "x-user-signature": "s" });
      h.set(name, "");
      let err: unknown;
      try {
        extractSignedIdentity(h);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(KamiwazaError);
      expect((err as KamiwazaError).code).toBe("missing_signature");
      expect((err as KamiwazaError).message).toContain(name);
    }
  });

  it("documents which forwarded headers are secrets", () => {
    for (const s of SECRET_IDENTITY_HEADERS) expect(SIGNED_IDENTITY_HEADERS).toContain(s);
    expect(SECRET_IDENTITY_HEADERS).toContain("x-user-signature");
    expect(SECRET_IDENTITY_HEADERS).toContain("x-auth-token");
  });
});

describe("assertCallerHeaders", () => {
  it("lower-cases benign headers and rejects reserved ones regardless of case", () => {
    expect(assertCallerHeaders({ "X-Replay-Branch": "b1" })).toEqual({ "x-replay-branch": "b1" });
    expect(assertCallerHeaders(undefined)).toEqual({});
    for (const name of ["X-Forwarded-For", "x-user-anything", "X-AUTH-TOKEN", "Authorization", "X-Workroom-Id", "Host", "Cookie", "X-Verified-Workroom-Scope", "X-Authz-Outcome"]) {
      expect(() => assertCallerHeaders({ [name]: "v" })).toThrow(/reserved/);
    }
    expect(() => assertCallerHeaders({ "x-ok": 1 as unknown as string })).toThrow(/must be a string/);
  });
});

describe("redaction", () => {
  it("removes known secrets, bearer strings and JWT-shaped tokens; ignores trivially short secrets", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1MSIsInNpZCI6InMifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
    const text = `denied for Bearer abc.def token=kz_pat_SECRET ${jwt} short`;
    const out = redactSecrets(text, ["kz_pat_SECRET", "short", null, undefined, "abc"]);
    // "short" and "abc" are below the minimum secret length, so they are not treated as secrets
    // (blanket-replacing tiny strings would mangle messages without protecting anything).
    expect(out).toBe("denied for Bearer [redacted] token=[redacted] [redacted-jwt] short");
  });

  it("extracts a bounded, redacted detail from FastAPI error bodies", () => {
    expect(extractErrorDetail({ detail: "nope SECRET1" }, ["SECRET1"])).toBe("nope [redacted]");
    expect(extractErrorDetail({ detail: [{ loc: ["body", "x"], msg: "bad", type: "t" }, { msg: "worse" }] }, [])).toBe("body.x: bad; worse");
    expect(extractErrorDetail({ detail: { message: "obj" } }, [])).toBe("obj");
    expect(extractErrorDetail({ detail: "y".repeat(500) }, [])!.length).toBeLessThanOrEqual(241);
    expect(extractErrorDetail("string body", [])).toBeUndefined();
    expect(extractErrorDetail({ error: "x" }, [])).toBeUndefined();
    expect(extractErrorDetail(null, [])).toBeUndefined();
  });
});

describe("CapabilityRegistry", () => {
  it("starts unverified, keeps the first verification time and reports the latest evidence", () => {
    const r = new CapabilityRegistry();
    expect(r.isNative("rebac")).toBe(false);
    r.markNative("rebac", { target: "POST /auth/check", requestId: "r1", at: "2026-09-13T01:00:00.000Z" });
    r.markNative("rebac", { target: "POST /auth/check", requestId: "r2", at: "2026-09-13T02:00:00.000Z" });
    expect(r.snapshot().rebac).toEqual({ capability: "rebac", label: "native", verifiedAt: "2026-09-13T01:00:00.000Z", lastTarget: "POST /auth/check", lastRequestId: "r2" });
    expect(r.snapshot().identity.label).toBe("unverified");
    expect(Object.isFrozen(r.snapshot())).toBe(true);
  });
});
