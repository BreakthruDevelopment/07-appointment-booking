#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up two users, publishes one provider, and proves the other cannot edit that service.
#   BASE_URL=https://app7.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /dashboard /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard and admin redirect"

signup() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}

json_field() {
  # Read JSON on stdin and print the value of a dotted path (objects only).
  node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); let v=j; for (const k of process.argv[1].split(".")) v=v?.[k]; if (v===undefined||v===null) process.exit(1); process.stdout.write(String(v));})' "$1"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two users signed up"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/providers/missing-studio")
[ "$code" = "404" ] || fail "unknown public provider should be 404, got $code"
pass "unknown provider is 404"

code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
  -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"slug":"anon-studio","displayName":"Nope","timeZone":"UTC","accepting":true,"minNoticeMinutes":0,"horizonDays":14}' \
  "$BASE_URL/api/provider/profile")
[ "$code" = "401" ] || fail "anonymous profile write should be 401, got $code"
pass "anonymous profile write refused"

SLUG="smoke-$RUN_ID"
profile=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -X PUT \
  -d "{\"slug\":\"$SLUG\",\"displayName\":\"Smoke Studio\",\"bio\":\"\",\"timeZone\":\"UTC\",\"accepting\":true,\"minNoticeMinutes\":0,\"horizonDays\":30}" \
  "$BASE_URL/api/provider/profile") || fail "create profile failed"
echo "$profile" | grep -q '"slug":"'"$SLUG"'"' || fail "profile response missing slug: $profile"
pass "user A published a provider profile"

curl -fsS -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" -X PUT \
  -d "{\"slug\":\"smoke-b-$RUN_ID\",\"displayName\":\"Other Studio\",\"bio\":\"\",\"timeZone\":\"UTC\",\"accepting\":false,\"minNoticeMinutes\":0,\"horizonDays\":14}" \
  "$BASE_URL/api/provider/profile" >/dev/null || fail "user B profile failed"
pass "user B has their own profile"

service=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -X PUT \
  -d '{"name":"Cut","durationMin":30,"active":true}' \
  "$BASE_URL/api/provider/services") || fail "create service failed"
SERVICE_ID=$(printf '%s' "$service" | json_field service.id) || fail "no service id in $service"
pass "user A added a service"

HOURS=$(node -e 'const hours=[]; for (let weekday=1; weekday<=7; weekday++) hours.push({weekday,startMin:0,endMin:1440}); process.stdout.write(JSON.stringify({hours}));')
curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -X PUT \
  -d "$HOURS" "$BASE_URL/api/provider/hours" >/dev/null || fail "save hours failed"
pass "user A saved weekly hours"

code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"id\":\"$SERVICE_ID\",\"name\":\"Nope\",\"durationMin\":30}" \
  "$BASE_URL/api/provider/services")
[ "$code" = "404" ] || fail "user B editing A's service should be 404, got $code"
pass "user B cannot edit A's service"

public=$(curl -fsS "$BASE_URL/api/providers/$SLUG") || fail "public provider failed"
printf '%s' "$public" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const body=JSON.stringify(j); if(!j.provider||j.provider.displayName!=="Smoke Studio") process.exit(2); if (/"userId"/.test(body)||/"email"/.test(body)) process.exit(3);});' \
  || fail "public provider leaked an owner field or missed the display name: $public"
pass "public provider hides the owner"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/providers/smoke-b-$RUN_ID")
[ "$code" = "404" ] || fail "a provider who is not accepting bookings should be 404 publicly, got $code"
pass "non-accepting provider is not public"

code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' \
  -d "{\"slug\":\"$SLUG\",\"displayName\":\"Hijack\",\"bio\":\"\",\"timeZone\":\"UTC\",\"accepting\":true,\"minNoticeMinutes\":0,\"horizonDays\":30}" \
  "$BASE_URL/api/provider/profile")
[ "$code" = "403" ] || fail "cross-origin profile PUT should be 403, got $code"
pass "cross-origin write is refused"

FROM=$(node -e 'process.stdout.write(new Date(Date.now()+60*60*1000).toISOString())')
TO=$(node -e 'process.stdout.write(new Date(Date.now()+2*24*60*60*1000).toISOString())')
slots=$(curl -fsS --get "$BASE_URL/api/providers/$SLUG/slots" \
  --data-urlencode "serviceId=$SERVICE_ID" \
  --data-urlencode "from=$FROM" \
  --data-urlencode "to=$TO") || fail "slots request failed"
printf '%s' "$slots" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); if(j.timeZone!=="UTC"||!Array.isArray(j.slots)||j.slots.length===0) process.exit(1);});' \
  || fail "expected at least one open slot: $slots"
pass "public slots include an open time"

echo "SMOKE PASS"
