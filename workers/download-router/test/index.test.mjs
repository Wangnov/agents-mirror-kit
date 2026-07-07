import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";

// Mirrors codex-app-mirror's production ROUTE_CONFIG so these tests assert the
// generic worker reproduces the pre-extraction behavior exactly.
const CODEX_ROUTE_CONFIG = {
  aliases: {
    "/latest/win": { category: "installer", filename: "Codex-Windows-x64.msix", contentType: "application/vnd.ms-appx" },
    "/latest/win-x64": { category: "installer", filename: "Codex-Windows-x64.msix", contentType: "application/vnd.ms-appx" },
    "/latest/win-arm64": { category: "installer", filename: "Codex-Windows-arm64.msix", contentType: "application/vnd.ms-appx" },
    "/latest/mac-arm64": { category: "installer", filename: "Codex-mac-arm64.dmg", contentType: "application/x-apple-diskimage" },
    "/latest/mac-intel": { category: "installer", filename: "Codex-mac-x64.dmg", contentType: "application/x-apple-diskimage" },
    "/latest/checksums": { category: null, filename: "SHA256SUMS.txt", contentType: "text/plain; charset=utf-8" },
    "/latest/manifest": { category: null, filename: "release-manifest.json", contentType: "application/json" },
    "/latest/appcast.xml": { category: null },
    "/latest/appcast-x64.xml": { category: null },
  },
  patterns: [
    { regex: "^/latest/mac/(arm64|intel)/[^/]+\\.zip$", category: "update-full" },
    { regex: "^/latest/mac/(arm64|intel)/[^/]+\\.delta$", category: "update-delta" },
  ],
};

function baseEnv(overrides = {}) {
  return {
    ROUTE_CONFIG: CODEX_ROUTE_CONFIG,
    GLOBAL_MIRROR_BASE_URL: "https://r2.example.com",
    ...overrides,
  };
}

test("records installer downloads routed to the global mirror", async () => {
  const analytics = createAnalytics();
  const response = await worker.fetch(
    new Request("https://codexapp.agentsmirror.com/latest/win-x64", {
      headers: { "CF-IPCountry": "US" },
    }),
    baseEnv({ DOWNLOAD_ANALYTICS: analytics }),
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://r2.example.com/latest/win-x64");
  assert.deepEqual(analytics.points, [
    { blobs: ["global", "US", "installer"], doubles: [1], indexes: ["global"] },
  ]);
});

test("records update archive and delta categories", async () => {
  const analytics = createAnalytics();
  const env = baseEnv({ DOWNLOAD_ANALYTICS: analytics });

  await worker.fetch(new Request("https://codexapp.agentsmirror.com/latest/mac/arm64/Codex.zip"), env);
  await worker.fetch(new Request("https://codexapp.agentsmirror.com/latest/mac/intel/Codex.delta"), env);

  assert.deepEqual(
    analytics.points.map((point) => point.blobs),
    [
      ["global", "", "update-full"],
      ["global", "", "update-delta"],
    ],
  );
});

test("does not record metadata polling paths", async () => {
  const analytics = createAnalytics();
  const response = await worker.fetch(
    new Request("https://codexapp.agentsmirror.com/latest/manifest", {
      headers: { "CF-IPCountry": "CN" },
    }),
    baseEnv({ DOWNLOAD_ANALYTICS: analytics }),
  );

  assert.equal(response.status, 302);
  assert.deepEqual(analytics.points, []);
});

test("does not record non-GET download probes", async () => {
  const analytics = createAnalytics();
  const response = await worker.fetch(
    new Request("https://codexapp.agentsmirror.com/latest/win-x64", {
      method: "HEAD",
      headers: { "CF-IPCountry": "US" },
    }),
    baseEnv({ DOWNLOAD_ANALYTICS: analytics }),
  );

  assert.equal(response.status, 302);
  assert.deepEqual(analytics.points, []);
});

test("rejects unknown paths", async () => {
  const response = await worker.fetch(
    new Request("https://codexapp.agentsmirror.com/latest/nope"),
    baseEnv(),
  );
  assert.equal(response.status, 404);
});

test("records secondary mirror downloads after successful presign", async () => {
  const analytics = createAnalytics();
  const response = await worker.fetch(
    new Request("https://codexapp.agentsmirror.com/latest/mac-arm64", {
      headers: { "CF-IPCountry": "CN" },
    }),
    baseEnv({
      DOWNLOAD_ANALYTICS: analytics,
      SECONDARY_COUNTRY_CODES: "CN",
      SECONDARY_S3_ENDPOINT: "https://s3.example.com",
      SECONDARY_S3_BUCKET: "mirror-bucket",
      SECONDARY_S3_REGION: "auto",
      SECONDARY_S3_ACCESS_KEY_ID: "access-key",
      SECONDARY_S3_SECRET_ACCESS_KEY: "secret-key",
      SECONDARY_S3_PREFIX: "edge",
    }),
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("Location"));
  assert.equal(location.origin, "https://s3.example.com");
  assert.equal(location.pathname, "/mirror-bucket/edge/latest/mac-arm64");
  assert.equal(location.searchParams.get("response-content-disposition"), 'attachment; filename="Codex-mac-arm64.dmg"');
  assert.deepEqual(analytics.points, [
    { blobs: ["secondary", "CN", "installer"], doubles: [1], indexes: ["secondary"] },
  ]);
});

test("analytics failures do not block redirects", async () => {
  const response = await worker.fetch(
    new Request("https://codexapp.agentsmirror.com/latest/win"),
    baseEnv({
      DOWNLOAD_ANALYTICS: {
        writeDataPoint() {
          throw new Error("analytics down");
        },
      },
    }),
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://r2.example.com/latest/win");
});

test("accepts ROUTE_CONFIG as a JSON string", async () => {
  const response = await worker.fetch(
    new Request("https://codexapp.agentsmirror.com/latest/win-x64"),
    baseEnv({ ROUTE_CONFIG: JSON.stringify(CODEX_ROUTE_CONFIG) }),
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://r2.example.com/latest/win-x64");
});

test("fails closed when ROUTE_CONFIG is missing or malformed", async () => {
  const missing = await worker.fetch(
    new Request("https://codexapp.agentsmirror.com/latest/win-x64"),
    { GLOBAL_MIRROR_BASE_URL: "https://r2.example.com" },
  );
  assert.equal(missing.status, 500);

  const badPattern = await worker.fetch(
    new Request("https://codexapp.agentsmirror.com/latest/win-x64"),
    baseEnv({ ROUTE_CONFIG: { aliases: {}, patterns: [{ category: "x" }] } }),
  );
  assert.equal(badPattern.status, 500);
});

test("serves the stats badge JSON from the global mirror", async () => {
  const badge = '{"schemaVersion":1,"label":"downloads","message":"330.6k","color":"brightgreen"}';
  const response = await withFakeFetch(
    async (input) => {
      assert.equal(String(input), "https://r2.example.com/stats/downloads.json");
      return new Response(badge, { status: 200, headers: { "Content-Type": "application/json" } });
    },
    () => worker.fetch(new Request("https://codexapp.agentsmirror.com/stats/downloads.json"), baseEnv()),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(await response.text(), badge);
});

test("maps upstream badge failures to 404 and rejects other stats paths/methods", async () => {
  const failed = await withFakeFetch(
    async () => new Response("nope", { status: 404 }),
    () => worker.fetch(new Request("https://codexapp.agentsmirror.com/stats/downloads.json"), baseEnv()),
  );
  assert.equal(failed.status, 404);

  const otherPath = await worker.fetch(
    new Request("https://codexapp.agentsmirror.com/stats/state.json"),
    baseEnv(),
  );
  assert.equal(otherPath.status, 404);

  const post = await worker.fetch(
    new Request("https://codexapp.agentsmirror.com/stats/downloads.json", { method: "POST" }),
    baseEnv(),
  );
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("Allow"), "GET, HEAD");
});

async function withFakeFetch(fake, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function createAnalytics() {
  return {
    points: [],
    writeDataPoint(point) {
      this.points.push(structuredClone(point));
    },
  };
}
