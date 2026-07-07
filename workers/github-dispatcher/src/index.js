const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_USER_AGENT = "agents-mirror-dispatcher-cloudflare-cron";

export default {
  async scheduled(controller, env) {
    const result = await dispatchWorkflows(controller, env);
    console.log(JSON.stringify(result));
    return result;
  },
};

// Targets come from the DISPATCH_TARGETS JSON var so one deployed instance
// can fan out to any set of mirror repos. The legacy single-target vars
// (GITHUB_OWNER/GITHUB_REPO/...) are still honoured so pre-kit deployments
// keep working without a config change.
function resolveTargets(env) {
  if (env.DISPATCH_TARGETS) {
    let parsed;
    try {
      parsed = JSON.parse(env.DISPATCH_TARGETS);
    } catch (error) {
      throw new Error(`DISPATCH_TARGETS is not valid JSON: ${error.message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("DISPATCH_TARGETS must be a non-empty JSON array.");
    }
    return parsed.map((target, index) => {
      if (!target.owner || !target.repo) {
        throw new Error(`DISPATCH_TARGETS[${index}] must set owner and repo.`);
      }
      return {
        owner: target.owner,
        repo: target.repo,
        workflow: target.workflow || "mirror.yml",
        ref: target.ref || "main",
        inputs: target.inputs || {},
        required: target.required !== false,
      };
    });
  }

  if (!env.GITHUB_REPO) {
    throw new Error("Set DISPATCH_TARGETS or the legacy GITHUB_REPO var.");
  }
  return [
    {
      owner: env.GITHUB_OWNER || "Wangnov",
      repo: env.GITHUB_REPO,
      workflow: env.GITHUB_WORKFLOW || "mirror.yml",
      ref: env.GITHUB_REF || "main",
      inputs: {
        force_release: env.GITHUB_FORCE_RELEASE || "false",
      },
      required: true,
    },
  ];
}

async function dispatchWorkflows(controller, env) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN secret is not configured.");
  }

  const targets = resolveTargets(env);

  const settled = await Promise.allSettled(
    targets.map((target) => dispatchWorkflowTarget(controller, env, target)),
  );

  const results = settled.map((entry, index) => {
    if (entry.status === "fulfilled") {
      return entry.value;
    }

    return (
      entry.reason.result || {
        event: "github_workflow_dispatch",
        cron: controller.cron,
        ...targets[index],
        ok: false,
        error: entry.reason.message,
        at: new Date().toISOString(),
      }
    );
  });

  const succeeded = results.filter((result) => result.ok).length;
  const failed = results.length - succeeded;
  const failedRequired = results.filter((result) => result.required && !result.ok).length;
  const result = {
    event: "github_workflow_dispatch_batch",
    cron: controller.cron,
    ok: failedRequired === 0,
    succeeded,
    failed,
    failed_required: failedRequired,
    targets: results,
    at: new Date().toISOString(),
  };

  if (!result.ok) {
    console.error(JSON.stringify(result));
    throw new Error("One or more required GitHub workflow dispatches failed.");
  }

  if (failed > 0) {
    console.error(JSON.stringify(result));
  }

  return result;
}

async function dispatchWorkflowTarget(controller, env, target) {
  const { owner, repo, workflow, ref, inputs = {}, required = true } = target;
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": env.DISPATCH_USER_AGENT || DEFAULT_USER_AGENT,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    body: JSON.stringify({
      ref,
      inputs,
    }),
  });

  const result = {
    event: "github_workflow_dispatch",
    cron: controller.cron,
    owner,
    repo,
    workflow,
    ref,
    inputs,
    required,
    status: response.status,
    ok: response.ok,
    at: new Date().toISOString(),
  };

  if (!response.ok) {
    result.body = await response.text();
    console.error(JSON.stringify(result));
    const error = new Error(`GitHub workflow dispatch failed with HTTP ${response.status}.`);
    error.result = result;
    throw error;
  }

  console.log(JSON.stringify(result));
  return result;
}
