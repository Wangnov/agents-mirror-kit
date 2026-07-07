// Generic two-tier mirror download router.
//
// App-agnostic: geo-routing (secondary S3 mirror for configured countries,
// global R2 otherwise), S3 SigV4 presigning, Analytics Engine download
// counting, and a /stats/downloads.json badge proxy. The per-mirror specifics
// -- which /latest/* aliases exist, their download filenames/content-types,
// their analytics category, and the Sparkle archive path patterns -- come from
// the ROUTE_CONFIG var so one worker source serves every mirror.
//
// ROUTE_CONFIG (object in wrangler.jsonc, or a JSON string):
//   {
//     "aliases": {
//       "/latest/win-x64": { "category": "installer",
//                            "filename": "App.msix", "contentType": "..." },
//       "/latest/checksums": { "category": null,
//                              "filename": "SHA256SUMS.txt", "contentType": "..." },
//       "/latest/appcast.xml": { "category": null }
//     },
//     "patterns": [
//       { "regex": "^/latest/mac/(arm64|intel)/[^/]+\\.zip$",   "category": "update-full" },
//       { "regex": "^/latest/mac/(arm64|intel)/[^/]+\\.delta$", "category": "update-delta" }
//     ]
//   }
// A null category means the path is a valid alias but is not a user-facing
// download, so it is not counted in analytics.

const DEFAULT_SECONDARY_COUNTRY_CODES = "CN";
const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600;
const STATS_BADGE_PATH = "/stats/downloads.json";

let compiledConfigCache = null;
let compiledConfigSource = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/stats/")) {
      return serveStatsBadge(request, env, url.pathname);
    }

    let config;
    try {
      config = getRouteConfig(env);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "route_config_invalid",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return new Response("Invalid ROUTE_CONFIG", { status: 500 });
    }

    if (!isAllowedLatestPath(url.pathname, config)) {
      return new Response("Not found", { status: 404 });
    }

    const country = request.cf?.country || request.headers.get("CF-IPCountry") || "";
    const category = request.method === "GET" ? assetCategoryForPath(url.pathname, config) : null;
    const secondaryCountryCodes = new Set(
      (env.SECONDARY_COUNTRY_CODES || DEFAULT_SECONDARY_COUNTRY_CODES)
        .split(",")
        .map((code) => code.trim().toUpperCase())
        .filter(Boolean),
    );

    if (secondaryCountryCodes.has(country.toUpperCase()) && hasSecondaryS3Config(env)) {
      try {
        const objectKey = objectKeyForPath(url.pathname, env.SECONDARY_S3_PREFIX || "");
        const downloadMetadata = downloadMetadataForPath(url.pathname, config);
        const signedUrl = await presignS3GetUrl({
          endpoint: env.SECONDARY_S3_ENDPOINT,
          bucket: env.SECONDARY_S3_BUCKET,
          key: objectKey,
          region: env.SECONDARY_S3_REGION || "auto",
          accessKeyId: env.SECONDARY_S3_ACCESS_KEY_ID,
          secretAccessKey: env.SECONDARY_S3_SECRET_ACCESS_KEY,
          expiresInSeconds: ttlSeconds(env.SECONDARY_S3_SIGNED_URL_TTL_SECONDS),
          responseHeaders: downloadMetadata
            ? {
                "response-content-disposition": `attachment; filename="${downloadMetadata.filename}"`,
                "response-content-type": downloadMetadata.contentType,
              }
            : {},
        });

        recordDownload(env, "secondary", country, category);
        return redirect(signedUrl);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "secondary_s3_presign_failed",
            path: url.pathname,
            country,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    if (!env.GLOBAL_MIRROR_BASE_URL) {
      return new Response("Missing GLOBAL_MIRROR_BASE_URL", { status: 500 });
    }

    recordDownload(env, "global", country, category);
    return redirect(withPathAndSearch(env.GLOBAL_MIRROR_BASE_URL, url.pathname, url.search).toString(), {
      "X-Mirror-Fallback": "global",
    });
  },
};

// The zone apex may serve a website whose SPA fallback would answer /stats/*
// with HTML; this worker route owns the prefix so the shields.io badge endpoint
// keeps returning JSON. Served from R2 directly (no geo routing): the payload is
// a few hundred bytes and read mostly by shields.io.
async function serveStatsBadge(request, env, pathname) {
  if (pathname !== STATS_BADGE_PATH) {
    return new Response("Not found", { status: 404 });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }
  if (!env.GLOBAL_MIRROR_BASE_URL) {
    return new Response("Missing GLOBAL_MIRROR_BASE_URL", { status: 500 });
  }

  const target = withPathAndSearch(env.GLOBAL_MIRROR_BASE_URL, STATS_BADGE_PATH, "");
  const upstream = await fetch(target.toString(), { method: request.method });
  if (!upstream.ok) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function getRouteConfig(env) {
  const raw = env.ROUTE_CONFIG;
  if (raw === undefined || raw === null || raw === "") {
    throw new Error("ROUTE_CONFIG is not set");
  }
  // Cache the compiled form (parsed + regexes built) keyed by the raw source so
  // repeated requests do not re-parse. Structured jsonc vars arrive as objects;
  // stringify for a stable cache key.
  const source = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (compiledConfigCache && compiledConfigSource === source) {
    return compiledConfigCache;
  }

  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const aliases = parsed.aliases || {};
  const patterns = (parsed.patterns || []).map((pattern) => {
    if (!pattern || typeof pattern.regex !== "string") {
      throw new Error("each ROUTE_CONFIG pattern needs a regex string");
    }
    return { regex: new RegExp(pattern.regex), category: pattern.category ?? null };
  });
  if (Object.keys(aliases).length === 0 && patterns.length === 0) {
    throw new Error("ROUTE_CONFIG must define at least one alias or pattern");
  }

  compiledConfigCache = { aliases, patterns };
  compiledConfigSource = source;
  return compiledConfigCache;
}

function matchingPattern(pathname, config) {
  return config.patterns.find((pattern) => pattern.regex.test(pathname)) || null;
}

function isAllowedLatestPath(pathname, config) {
  if (Object.prototype.hasOwnProperty.call(config.aliases, pathname)) {
    return true;
  }
  return matchingPattern(pathname, config) !== null;
}

function assetCategoryForPath(pathname, config) {
  const alias = config.aliases[pathname];
  if (alias) {
    return alias.category ?? null;
  }
  const pattern = matchingPattern(pathname, config);
  return pattern ? pattern.category ?? null : null;
}

function downloadMetadataForPath(pathname, config) {
  const alias = config.aliases[pathname];
  if (alias && alias.filename && alias.contentType) {
    return { filename: alias.filename, contentType: alias.contentType };
  }
  return null;
}

function recordDownload(env, route, country, category) {
  if (!category) {
    return;
  }
  const dataset = env.DOWNLOAD_ANALYTICS;
  if (!dataset) {
    return;
  }
  // writeDataPoint is non-blocking: the point is buffered and flushed by the
  // runtime after the response is sent, so it adds no latency to the redirect.
  try {
    dataset.writeDataPoint({
      blobs: [route, country || "", category],
      doubles: [1],
      indexes: [route],
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "download_analytics_write_failed",
        route,
        category,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function hasSecondaryS3Config(env) {
  return Boolean(
    env.SECONDARY_S3_ENDPOINT &&
      env.SECONDARY_S3_BUCKET &&
      env.SECONDARY_S3_ACCESS_KEY_ID &&
      env.SECONDARY_S3_SECRET_ACCESS_KEY,
  );
}

function ttlSeconds(value) {
  const parsed = Number.parseInt(value || DEFAULT_SIGNED_URL_TTL_SECONDS, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SIGNED_URL_TTL_SECONDS;
  }
  return Math.min(Math.max(parsed, 1), 604800);
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "private, no-store",
      ...extraHeaders,
    },
  });
}

function withPathAndSearch(baseUrl, pathname, search) {
  const target = new URL(baseUrl);
  const basePath = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
  target.pathname = `${basePath}${pathname}`;
  target.search = search;
  return target;
}

function objectKeyForPath(pathname, prefix) {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const cleanPath = pathname.replace(/^\/+/, "");
  return cleanPrefix ? `${cleanPrefix}/${cleanPath}` : cleanPath;
}

async function presignS3GetUrl(options) {
  const endpointUrl = new URL(options.endpoint);
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${options.region}/s3/aws4_request`;
  const signedHeaders = "host";
  const canonicalUri = canonicalS3Uri(endpointUrl, options.bucket, options.key);

  const queryParams = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${options.accessKeyId}/${credentialScope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(options.expiresInSeconds)],
    ["X-Amz-SignedHeaders", signedHeaders],
    ...Object.entries(options.responseHeaders || {}),
  ];
  const canonicalQuery = canonicalQueryString(queryParams);
  const canonicalHeaders = `host:${endpointUrl.host}\n`;
  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");
  const signingKey = await signingKeyBytes(options.secretAccessKey, dateStamp, options.region, "s3");
  const signature = toHex(await hmac(signingKey, stringToSign));

  endpointUrl.pathname = canonicalUri;
  endpointUrl.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
  return endpointUrl.toString();
}

function canonicalS3Uri(endpointUrl, bucket, key) {
  const basePath = endpointUrl.pathname === "/" ? "" : endpointUrl.pathname.replace(/\/$/, "");
  const encodedKey = key.split("/").map(encodeRfc3986).join("/");
  return `${basePath}/${encodeRfc3986(bucket)}/${encodedKey}`;
}

function canonicalQueryString(params) {
  return params
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) {
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      }
      return leftKey < rightKey ? -1 : 1;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function signingKeyBytes(secretAccessKey, dateStamp, region, service) {
  const dateKey = await hmac(utf8(`AWS4${secretAccessKey}`), dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", utf8(value));
  return toHex(new Uint8Array(digest));
}

async function hmac(keyBytes, value) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, utf8(value));
  return new Uint8Array(signature);
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
