#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d)"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

mkdir -p "$tmp_dir/bin" "$tmp_dir/src"
aws_log="$tmp_dir/aws.log"
config_snapshot="$tmp_dir/aws-config.snapshot"
attempt_counter="$tmp_dir/attempt.count"
: > "$aws_log"
printf '0' > "$attempt_counter"

cat > "$tmp_dir/bin/aws" <<'AWS'
#!/usr/bin/env bash
set -euo pipefail

printf 'CALL %s\n' "$*" >> "${TEST_AWS_LOG:?TEST_AWS_LOG must be set}"
printf 'ENV CHECKSUM_REQ=%s CHECKSUM_RESP=%s MAX_ATTEMPTS=%s RETRY_MODE=%s\n' \
  "${AWS_REQUEST_CHECKSUM_CALCULATION:-}" \
  "${AWS_RESPONSE_CHECKSUM_VALIDATION:-}" \
  "${AWS_MAX_ATTEMPTS:-}" \
  "${AWS_RETRY_MODE:-}" >> "$TEST_AWS_LOG"

if [[ -n "${AWS_CONFIG_FILE:-}" && -f "$AWS_CONFIG_FILE" ]]; then
  cp "$AWS_CONFIG_FILE" "${TEST_AWS_CONFIG_SNAPSHOT:?TEST_AWS_CONFIG_SNAPSHOT must be set}"
fi

count="$(cat "${TEST_ATTEMPT_COUNTER:?TEST_ATTEMPT_COUNTER must be set}")"
count=$((count + 1))
printf '%s' "$count" > "$TEST_ATTEMPT_COUNTER"

fail_until="${TEST_FAIL_UNTIL:-0}"
if ((count <= fail_until)); then
  echo "upload failed: s3://mirror/latest/mac/arm64/ChatGPT.delta An error occurred (InvalidPart) when calling the CompleteMultipartUpload operation: One or more of the specified parts could not be found." >&2
  exit 1
fi

exit 0
AWS
chmod +x "$tmp_dir/bin/aws"

printf 'delta-bytes' > "$tmp_dir/src/ChatGPT30607-28661-arm64.delta"

# Case 1: Retries transient R2 CompleteMultipartUpload InvalidPart errors and succeeds on attempt 3.
(
  cd "$repo_root"
  PATH="$tmp_dir/bin:$PATH" \
  TEST_AWS_LOG="$aws_log" \
  TEST_AWS_CONFIG_SNAPSHOT="$config_snapshot" \
  TEST_ATTEMPT_COUNTER="$attempt_counter" \
  TEST_FAIL_UNTIL=2 \
  R2_S3_ENDPOINT="https://example.r2.cloudflarestorage.com" \
  AWS_ACCESS_KEY_ID="test-key" \
  AWS_SECRET_ACCESS_KEY="test-secret" \
  R2_UPLOAD_ATTEMPTS=4 \
  R2_RETRY_SLEEP_SECONDS=0 \
    bash scripts/sync-r2.sh --object codex-app-mirror latest/mac/arm64/ChatGPT30607-28661-arm64.delta "$tmp_dir/src/ChatGPT30607-28661-arm64.delta"
)

test "$(cat "$attempt_counter")" = "3"
grep -Fq 'ENV CHECKSUM_REQ=when_required CHECKSUM_RESP=when_required MAX_ATTEMPTS=5 RETRY_MODE=standard' "$aws_log"
grep -Fq -- '--cli-connect-timeout 30' "$aws_log"
grep -Fq -- '--cli-read-timeout 180' "$aws_log"
grep -Fq 'multipart_threshold = 64MB' "$config_snapshot"
grep -Fq 'multipart_chunksize = 64MB' "$config_snapshot"
grep -Fq 'max_concurrent_requests = 4' "$config_snapshot"

# Case 2: Preserves caller-provided AWS_CONFIG_FILE (sync-secondary-s3.sh contract).
caller_config="$tmp_dir/caller-aws.config"
cat > "$caller_config" <<'EOF'
[default]
region = auto
s3 =
    addressing_style = path
    max_concurrent_requests = 1
EOF
printf '0' > "$attempt_counter"
rm -f "$config_snapshot"

(
  cd "$repo_root"
  PATH="$tmp_dir/bin:$PATH" \
  TEST_AWS_LOG="$aws_log" \
  TEST_AWS_CONFIG_SNAPSHOT="$config_snapshot" \
  TEST_ATTEMPT_COUNTER="$attempt_counter" \
  TEST_FAIL_UNTIL=0 \
  AWS_CONFIG_FILE="$caller_config" \
  R2_S3_ENDPOINT="https://example.r2.cloudflarestorage.com" \
  AWS_ACCESS_KEY_ID="test-key" \
  AWS_SECRET_ACCESS_KEY="test-secret" \
    bash scripts/sync-r2.sh --object codex-app-mirror latest/manifest "$tmp_dir/src/ChatGPT30607-28661-arm64.delta" release-manifest.json
)

cmp -s "$caller_config" "$config_snapshot"

# Case 3: Fails after exhausting R2_UPLOAD_ATTEMPTS.
printf '0' > "$attempt_counter"
if (
  cd "$repo_root"
  PATH="$tmp_dir/bin:$PATH" \
  TEST_AWS_LOG="$aws_log" \
  TEST_AWS_CONFIG_SNAPSHOT="$config_snapshot" \
  TEST_ATTEMPT_COUNTER="$attempt_counter" \
  TEST_FAIL_UNTIL=5 \
  R2_S3_ENDPOINT="https://example.r2.cloudflarestorage.com" \
  AWS_ACCESS_KEY_ID="test-key" \
  AWS_SECRET_ACCESS_KEY="test-secret" \
  R2_UPLOAD_ATTEMPTS=2 \
  R2_RETRY_SLEEP_SECONDS=0 \
    bash scripts/sync-r2.sh --object codex-app-mirror latest/win "$tmp_dir/src/ChatGPT30607-28661-arm64.delta" Codex-Windows-x64.msix
); then
  echo "Expected sync-r2.sh to fail when all upload attempts fail." >&2
  exit 1
fi
test "$(cat "$attempt_counter")" = "2"

echo "sync-r2 retry and R2 multipart config fixture PASS"
