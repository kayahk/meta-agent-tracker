#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $# -ne 1 ]]; then
  echo "usage: patch-github-webhook-url.sh https://<public-host>/webhooks/github" >&2
  exit 2
fi
public_url="$1"
: "${META_AGENT_GITHUB_APP_ID:?META_AGENT_GITHUB_APP_ID must be set}"
: "${META_AGENT_GITHUB_PRIVATE_KEY_PATH:?META_AGENT_GITHUB_PRIVATE_KEY_PATH must be set}"

b64url() {
  base64 | tr '+/' '-_' | tr -d '=\n'
}

tmpdir="$(mktemp -d /tmp/meta-agent-github-hook.XXXXXX)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

now="$(date +%s)"
iat="$((now - 60))"
exp="$((now + 600))"
header='{"alg":"RS256","typ":"JWT"}'
payload="$(iat="$iat" exp="$exp" /usr/bin/python3 -c 'import json,os; print(json.dumps({"iat": int(os.environ["iat"]), "exp": int(os.environ["exp"]), "iss": os.environ["META_AGENT_GITHUB_APP_ID"]}, separators=(",", ":")))')"
unsigned="$(printf '%s' "$header" | b64url).$(printf '%s' "$payload" | b64url)"
printf '%s' "$unsigned" > "$tmpdir/unsigned.txt"
openssl dgst -sha256 -sign "$META_AGENT_GITHUB_PRIVATE_KEY_PATH" -binary -out "$tmpdir/signature.bin" "$tmpdir/unsigned.txt"
sig="$(b64url < "$tmpdir/signature.bin")"
token_value="${unsigned}.${sig}"
body="$(/usr/bin/python3 -c 'import json,sys; print(json.dumps({"url": sys.argv[1]}))' "$public_url")"
auth_scheme="Bearer"
auth_header="Authorization: ${auth_scheme} ${token_value}"
response="$(curl -sS -f -m 20 -X PATCH \
  -H "$auth_header" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  --data "$body" \
  https://api.github.com/app/hook/config)"
actual="$(printf '%s' "$response" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("url", ""))')"
if [[ "$actual" != "$public_url" ]]; then
  echo "GitHub returned unexpected hook URL: ${actual}" >&2
  exit 1
fi
echo "patched GitHub App webhook URL: ${actual}"
