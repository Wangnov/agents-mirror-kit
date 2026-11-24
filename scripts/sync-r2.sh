#!/usr/bin/env bash
set -euo pipefail

: "${R2_S3_ENDPOINT:?R2_S3_ENDPOINT must be set, for example https://<account-id>.r2.cloudflarestorage.com}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID must be set}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY must be set}"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required for multipart-capable R2 uploads." >&2
  exit 1
fi

require_non_negative_integer() {
  local name="$1"
  local value="$2"

  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "$name must be a non-negative integer, got '$value'." >&2
    exit 2
  fi
}

require_positive_integer() {
  local name="$1"
  local value="$2"

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$name must be a positive integer, got '$value'." >&2
    exit 2
  fi
}

region="${AWS_DEFAULT_REGION:-auto}"
upload_attempts="${R2_UPLOAD_ATTEMPTS:-4}"
retry_sleep="${R2_RETRY_SLEEP_SECONDS:-3}"
connect_timeout="${R2_CLI_CONNECT_TIMEOUT_SECONDS:-30}"
read_timeout="${R2_CLI_READ_TIMEOUT_SECONDS:-180}"
aws_max_attempts="${R2_AWS_MAX_ATTEMPTS:-5}"
aws_retry_mode="${R2_AWS_RETRY_MODE:-standard}"
multipart_threshold="${R2_MULTIPART_THRESHOLD:-64MB}"
multipart_chunksize="${R2_MULTIPART_CHUNKSIZE:-64MB}"
max_concurrent_requests="${R2_MAX_CONCURRENT_REQUESTS:-4}"

require_positive_integer R2_UPLOAD_ATTEMPTS "$upload_attempts"
require_non_negative_integer R2_RETRY_SLEEP_SECONDS "$retry_sleep"
require_non_negative_integer R2_CLI_CONNECT_TIMEOUT_SECONDS "$connect_timeout"
require_non_negative_integer R2_CLI_READ_TIMEOUT_SECONDS "$read_timeout"
require_positive_integer R2_AWS_MAX_ATTEMPTS "$aws_max_attempts"
require_positive_integer R2_MAX_CONCURRENT_REQUESTS "$max_concurrent_requests"

# AWS CLI v2 (>= 2.23) defaults to sending CRC32/CRC64NVME multipart part
# checksums ("when_supported"), which triggers intermittent InvalidPart errors
# on Cloudflare R2 CompleteMultipartUpload. Restrict optional SDK checksums to
# operations that strictly require them unless the caller overrides it.
export AWS_EC2_METADATA_DISABLED="${AWS_EC2_METADATA_DISABLED:-true}"
export AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-$aws_max_attempts}"
export AWS_RETRY_MODE="${AWS_RETRY_MODE:-$aws_retry_mode}"
export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"

tmp_aws_config=""
cleanup_aws_config() {
  if [[ -n "$tmp_aws_config" ]]; then
    rm -f "$tmp_aws_config"
  fi
}
trap cleanup_aws_config EXIT

# Respect caller-supplied AWS_CONFIG_FILE (e.g. sync-secondary-s3.sh); otherwise
# configure 64MB multipart chunks and bounded concurrency so 500-800MB installers
# use ~10-13 parts instead of ~100 x 8MB parts across 10 threads.
if [[ -z "${AWS_CONFIG_FILE:-}" ]]; then
  tmp_aws_config="$(mktemp)"
  cat > "$tmp_aws_config" <<EOF
[default]
region = $region
retry_mode = $AWS_RETRY_MODE
max_attempts = $AWS_MAX_ATTEMPTS
s3 =
    max_concurrent_requests = $max_concurrent_requests
    multipart_threshold = $multipart_threshold
    multipart_chunksize = $multipart_chunksize
EOF
  export AWS_CONFIG_FILE="$tmp_aws_config"
fi

content_type_for() {
  case "$1" in
    *.dmg) printf '%s' 'application/x-apple-diskimage' ;;
    *.Msix|*.msix) printf '%s' 'application/vnd.ms-appx' ;;
    *.json) printf '%s' 'application/json' ;;
    *.xml) printf '%s' 'application/xml' ;;
    *.zip) printf '%s' 'application/octet-stream' ;;
    *.txt) printf '%s' 'text/plain; charset=utf-8' ;;
    *) printf '%s' 'application/octet-stream' ;;
  esac
}

run_single_upload() {
  local file="$1"
  local object_path="$2"
  local download_name="$3"
  local content_type="$4"
  local cache_control="$5"
  local timeout_args=()

  if ((connect_timeout > 0)); then
    timeout_args+=(--cli-connect-timeout "$connect_timeout")
  fi
  if ((read_timeout > 0)); then
    timeout_args+=(--cli-read-timeout "$read_timeout")
  fi

  case "${R2_UPLOAD_MODE:-s3-cp}" in
    s3-cp)
      aws s3 cp "$file" "s3://$bucket/$object_path" \
        --endpoint-url "$R2_S3_ENDPOINT" \
        --region "$region" \
        --content-type "$content_type" \
        --content-disposition "attachment; filename=\"$download_name\"" \
        --cache-control "$cache_control" \
        --no-progress \
        "${timeout_args[@]}"
      ;;
    put-object)
      aws s3api put-object \
        --bucket "$bucket" \
        --key "$object_path" \
        --body "$file" \
        --endpoint-url "$R2_S3_ENDPOINT" \
        --region "$region" \
        --content-type "$content_type" \
        --content-disposition "attachment; filename=\"$download_name\"" \
        --cache-control "$cache_control" \
        "${timeout_args[@]}"
      ;;
    *)
      echo "R2_UPLOAD_MODE must be s3-cp or put-object, got '${R2_UPLOAD_MODE:-}'." >&2
      return 2
      ;;
  esac
}

upload_file() {
  local file="$1"
  local object_path="${2#/}"
  local download_name="$3"
  local content_type_source="$4"
  local cache_control="${R2_CACHE_CONTROL:-no-cache}"
  local content_type
  local attempt
  local delay="$retry_sleep"
  local rc=0

  if [[ ! -f "$file" ]]; then
    echo "Not a file: $file" >&2
    exit 1
  fi

  if [[ -z "$object_path" || -z "$download_name" ]]; then
    echo "Object path and download name are required." >&2
    exit 2
  fi

  case "${R2_UPLOAD_MODE:-s3-cp}" in
    s3-cp|put-object) ;;
    *)
      echo "R2_UPLOAD_MODE must be s3-cp or put-object, got '${R2_UPLOAD_MODE:-}'." >&2
      exit 2
      ;;
  esac

  content_type="$(content_type_for "$content_type_source")"

  for ((attempt = 1; attempt <= upload_attempts; attempt++)); do
    if ((attempt == 1)); then
      echo "Uploading $file to r2://$bucket/$object_path"
    else
      echo "Uploading $file to r2://$bucket/$object_path (attempt $attempt/$upload_attempts)"
    fi

    if run_single_upload "$file" "$object_path" "$download_name" "$content_type" "$cache_control"; then
      return 0
    else
      rc=$?
    fi

    if ((attempt == upload_attempts)); then
      return "$rc"
    fi

    echo "R2 upload failed for r2://$bucket/$object_path (attempt $attempt/$upload_attempts, exit $rc); retrying in ${delay}s." >&2
    if ((delay > 0)); then
      sleep "$delay"
      delay=$((delay * 2))
    fi
  done
}

if [[ "${1:-}" == "--object" ]]; then
  if [[ $# -lt 4 || $# -gt 5 ]]; then
    echo "Usage: sync-r2.sh --object <bucket> <object-key> <file> [download-name]" >&2
    exit 2
  fi

  bucket="$2"
  object_path="$3"
  file="$4"
  download_name="${5:-$(basename "$file")}"

  if [[ -z "$bucket" ]]; then
    echo "Bucket is required." >&2
    exit 2
  fi

  upload_file "$file" "$object_path" "$download_name" "$(basename "$file")"
  exit 0
fi

if [[ $# -lt 3 ]]; then
  echo "Usage: sync-r2.sh <bucket> <prefix> <file> [file ...]" >&2
  exit 2
fi

bucket="$1"
prefix="${2#/}"
prefix="${prefix%/}"
shift 2

if [[ -z "$bucket" || -z "$prefix" ]]; then
  echo "Bucket and prefix are required." >&2
  exit 2
fi

for file in "$@"; do
  name="$(basename "$file")"
  upload_file "$file" "$prefix/$name" "$name" "$name"
done
