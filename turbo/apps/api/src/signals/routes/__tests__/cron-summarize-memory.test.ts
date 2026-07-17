import { randomUUID } from "node:crypto";

import { cronSummarizeMemoryContract } from "@vm0/api-contracts/contracts/cron";
import { zeroMemoryDevRefreshContract } from "@vm0/api-contracts/contracts/zero-memory-dev-refresh";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const FIXED_NOW_ISO = "2999-01-03T12:00:00.000Z";

function apiClient() {
  return setupApp({ context })(cronSummarizeMemoryContract);
}

function devRefreshClient() {
  return setupApp({ context })(zeroMemoryDevRefreshContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function cronHeaders(secret = "test-cron-secret") {
  return { authorization: `Bearer ${secret}` };
}

async function rawCronRequest(
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request("/api/cron/summarize-memory", {
    method: "GET",
    headers,
  });
}

describe("GET /api/cron/summarize-memory", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date(FIXED_NOW_ISO));
  });

  afterEach(() => {
    clearMockNow();
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      apiClient().summarize({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("rejects requests with a missing authorization header", async () => {
    const response = await rawCronRequest();
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("returns a successful result for an authorized shared sweep", async () => {
    const response = await accept(
      apiClient().summarize({ headers: cronHeaders() }),
      [200],
    );

    // This endpoint intentionally scans every eligible user. Other Vitest
    // workers share the integration database, so an otherwise idle sweep can
    // summarize rows created concurrently by another test file.
    if ("summarized" in response.body) {
      expect(response.body.summarized).toBeGreaterThan(0);
    } else {
      expect(response.body).toStrictEqual({ skipped: true });
    }
  });
});

describe("POST /api/zero/memory/dev-refresh", () => {
  beforeEach(() => {
    mockNow(new Date(FIXED_NOW_ISO));
  });

  afterEach(() => {
    clearMockNow();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      devRefreshClient().refresh({ headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("rejects non-staff users outside development", async () => {
    mockEnv("ENV", "production");
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      devRefreshClient().refresh({ headers: authHeaders() }),
      [403],
    ).finally(() => {
      mockEnv("ENV", "development");
    });

    expect(response.body).toStrictEqual({
      error: {
        message: "Memory dev refresh is only available to staff",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns skipped for an isolated user without memory artifacts", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      devRefreshClient().refresh({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ skipped: true });
  });
});
