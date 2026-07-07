import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";

const CONTROLLER = { cron: "7,22,37,52 * * * *" };

test("dispatches every DISPATCH_TARGETS entry", async () => {
  const calls = [];
  const result = await withFakeFetch(
    async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    },
    () =>
      worker.scheduled(CONTROLLER, {
        GITHUB_TOKEN: "token",
        DISPATCH_TARGETS: JSON.stringify([
          { owner: "Wangnov", repo: "codex-app-mirror", inputs: { force_release: "false" } },
          { owner: "Wangnov", repo: "agents-cli-mirror" },
          { owner: "Wangnov", repo: "claude-app-mirror", required: false },
        ]),
      }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.succeeded, 3);
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "https://api.github.com/repos/Wangnov/codex-app-mirror/actions/workflows/mirror.yml/dispatches",
      "https://api.github.com/repos/Wangnov/agents-cli-mirror/actions/workflows/mirror.yml/dispatches",
      "https://api.github.com/repos/Wangnov/claude-app-mirror/actions/workflows/mirror.yml/dispatches",
    ],
  );
  assert.deepEqual(calls[0].body, { ref: "main", inputs: { force_release: "false" } });
  assert.deepEqual(calls[1].body, { ref: "main", inputs: {} });
});

test("legacy single-target vars keep working unchanged", async () => {
  const calls = [];
  const result = await withFakeFetch(
    async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    },
    () =>
      worker.scheduled(CONTROLLER, {
        GITHUB_TOKEN: "token",
        GITHUB_REPO: "claude-app-mirror",
      }),
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/Wangnov/claude-app-mirror/actions/workflows/mirror.yml/dispatches",
  );
  assert.deepEqual(calls[0].body, { ref: "main", inputs: { force_release: "false" } });
});

test("a failed required target fails the batch", async () => {
  await withFakeFetch(
    async (input) =>
      String(input).includes("codex-app-mirror")
        ? new Response("boom", { status: 500 })
        : new Response(null, { status: 204 }),
    async () => {
      await assert.rejects(
        worker.scheduled(CONTROLLER, {
          GITHUB_TOKEN: "token",
          DISPATCH_TARGETS: JSON.stringify([
            { owner: "Wangnov", repo: "codex-app-mirror" },
            { owner: "Wangnov", repo: "agents-cli-mirror" },
          ]),
        }),
        /required GitHub workflow dispatches failed/,
      );
    },
  );
});

test("a failed optional target does not fail the batch", async () => {
  const result = await withFakeFetch(
    async (input) =>
      String(input).includes("claude-app-mirror")
        ? new Response("boom", { status: 500 })
        : new Response(null, { status: 204 }),
    () =>
      worker.scheduled(CONTROLLER, {
        GITHUB_TOKEN: "token",
        DISPATCH_TARGETS: JSON.stringify([
          { owner: "Wangnov", repo: "codex-app-mirror" },
          { owner: "Wangnov", repo: "claude-app-mirror", required: false },
        ]),
      }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.failed, 1);
  assert.equal(result.failed_required, 0);
});

test("rejects missing token, bad JSON, and incomplete targets", async () => {
  await assert.rejects(
    worker.scheduled(CONTROLLER, { DISPATCH_TARGETS: "[]" }),
    /GITHUB_TOKEN secret is not configured/,
  );
  await assert.rejects(
    worker.scheduled(CONTROLLER, { GITHUB_TOKEN: "token", DISPATCH_TARGETS: "not json" }),
    /not valid JSON/,
  );
  await assert.rejects(
    worker.scheduled(CONTROLLER, { GITHUB_TOKEN: "token", DISPATCH_TARGETS: "[]" }),
    /non-empty JSON array/,
  );
  await assert.rejects(
    worker.scheduled(CONTROLLER, {
      GITHUB_TOKEN: "token",
      DISPATCH_TARGETS: JSON.stringify([{ owner: "Wangnov" }]),
    }),
    /must set owner and repo/,
  );
  await assert.rejects(
    worker.scheduled(CONTROLLER, { GITHUB_TOKEN: "token" }),
    /Set DISPATCH_TARGETS or the legacy GITHUB_REPO var/,
  );
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
