#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up users, publishes one provider, proves the other cannot edit that service, then runs the booking flow:
# customer A books, customer B gets 409 for the same time and 404 on A's booking and .ics, A cancels,
# and the provider's private calendar feed shows the cancelled booking.
#   BASE_URL=https://app7.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"; JAR_C="$(mktemp)"; JAR_D="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B" "$JAR_C" "$JAR_D"' EXIT

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
  local jar=$1 email=$2 code attempt
  # Better Auth rate-limits sign-ups per IP (a few per 10 seconds); wait it out and retry.
  for attempt in 1 2 3 4 5 6; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
      -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke Tester\"}" \
      "$BASE_URL/api/auth/sign-up/email")
    [ "$code" = "200" ] && return 0
    [ "$code" = "429" ] || fail "sign-up failed for $email (HTTP $code)"
    sleep 5
  done
  fail "sign-up for $email kept hitting the rate limit"
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

# ---------------------------------------------------------------------------
# Bookings: A and B are the customers here (users C and D), the provider is user A above.
# ---------------------------------------------------------------------------
signup "$JAR_C" "smoke-c-$RUN_ID@example.test"
signup "$JAR_D" "smoke-d-$RUN_ID@example.test"
pass "two customers signed up"

SLOT=$(printf '%s' "$slots" | json_field slots.0) || fail "no slot to book in $slots"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"serviceId\":\"$SERVICE_ID\",\"startsAt\":\"$SLOT\"}" "$BASE_URL/api/bookings")
[ "$code" = "401" ] || fail "anonymous booking should be 401, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_C" -H 'content-type: application/json' -H 'origin: https://evil.example' \
  -d "{\"serviceId\":\"$SERVICE_ID\",\"startsAt\":\"$SLOT\"}" "$BASE_URL/api/bookings")
[ "$code" = "403" ] || fail "cross-origin booking should be 403, got $code"
pass "anonymous and cross-origin bookings are refused"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_C" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"serviceId\":\"$SERVICE_ID\",\"startsAt\":\"2000-01-01T00:00:00Z\"}" "$BASE_URL/api/bookings")
[ "$code" = "409" ] || fail "a time that was never on offer should be 409, got $code"
pass "a time outside availability is refused, whatever the client says"

booked=$(curl -fsS -b "$JAR_C" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"serviceId\":\"$SERVICE_ID\",\"startsAt\":\"$SLOT\",\"note\":\"smoke\"}" "$BASE_URL/api/bookings") || fail "customer A could not book $SLOT"
BOOKING_ID=$(printf '%s' "$booked" | json_field booking.id) || fail "no booking id in $booked"
pass "customer A booked an open slot"

taken=$(curl -s -w '\n%{http_code}' -X POST -b "$JAR_D" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"serviceId\":\"$SERVICE_ID\",\"startsAt\":\"$SLOT\"}" "$BASE_URL/api/bookings")
[ "$(printf '%s' "$taken" | tail -n1)" = "409" ] || fail "customer B booking the same slot should be 409, got: $taken"
printf '%s' "$taken" | head -n1 | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); if(j.code!=="slot_taken"||!Array.isArray(j.slots)||j.slots.includes(process.argv[1])) process.exit(1);});' "$SLOT" \
  || fail "409 should say slot_taken and offer fresh slots without the taken one: $taken"
pass "customer B gets 409 with fresh slots for the same time"

for path in "/api/bookings/$BOOKING_ID" "/api/bookings/$BOOKING_ID/ics"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_D" "$BASE_URL$path")
  [ "$code" = "404" ] || fail "customer B on $path should be 404, got $code"
done
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_D" -H "origin: $BASE_URL" "$BASE_URL/api/bookings/$BOOKING_ID/cancel")
[ "$code" = "404" ] || fail "customer B cancelling A's booking should be 404, got $code"
pass "customer B gets 404 on A's booking, .ics and cancel"

ics_headers=$(curl -sS -D - -o /dev/null -b "$JAR_C" "$BASE_URL/api/bookings/$BOOKING_ID/ics") || fail "ics request failed"
echo "$ics_headers" | grep -qi '^content-type: text/calendar' || fail "ics should be text/calendar: $ics_headers"
ics=$(curl -fsS -b "$JAR_C" "$BASE_URL/api/bookings/$BOOKING_ID/ics") || fail "customer A could not download the .ics"
echo "$ics" | grep -q 'STATUS:CONFIRMED' || fail ".ics should be confirmed: $ics"
pass "customer A downloads the .ics"
curl -fsS -b "$JAR_A" "$BASE_URL/api/bookings/$BOOKING_ID/ics" >/dev/null || fail "the provider could not download the .ics"
pass "the provider can read it too"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_C" -H "origin: $BASE_URL" "$BASE_URL/api/provider/feed")
[ "$code" = "404" ] || fail "a customer without a provider profile should not get a feed, got $code"
feed=$(curl -fsS -b "$JAR_A" -X POST -H "origin: $BASE_URL" "$BASE_URL/api/provider/feed") || fail "provider could not create a feed"
FEED_URL=$(printf '%s' "$feed" | json_field url) || fail "no feed url in $feed"
FEED_PATH="/api/calendar/${FEED_URL##*/api/calendar/}"
feed_ics=$(curl -fsS "$BASE_URL$FEED_PATH") || fail "feed not served at $FEED_PATH"
echo "$feed_ics" | grep -q "UID:$BOOKING_ID@" || fail "feed should list the booking"
echo "$feed_ics" | grep -q 'STATUS:CONFIRMED' || fail "feed should show the booking as confirmed"
if echo "$feed_ics" | grep -q '@example.test'; then fail "feed leaked an email address"; fi
pass "provider feed lists the booking without an email"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/calendar/not-a-real-token.ics")
[ "$code" = "404" ] || fail "an unknown feed token should be 404, got $code"
pass "unknown feed token is 404"

cancelled=$(curl -fsS -X POST -b "$JAR_C" -H "origin: $BASE_URL" "$BASE_URL/api/bookings/$BOOKING_ID/cancel") || fail "customer A could not cancel"
printf '%s' "$cancelled" | json_field booking.status | grep -qx cancelled || fail "booking should be cancelled: $cancelled"
again=$(curl -fsS -X POST -b "$JAR_C" -H "origin: $BASE_URL" "$BASE_URL/api/bookings/$BOOKING_ID/cancel") || fail "cancelling twice should be fine"
printf '%s' "$again" | json_field booking.sequence | grep -qx 1 || fail "second cancel should leave sequence at 1: $again"
pass "customer A cancelled, and cancelling again is harmless"

feed_ics=$(curl -fsS "$BASE_URL$FEED_PATH") || fail "feed not served after cancel"
echo "$feed_ics" | grep -q 'STATUS:CANCELLED' || fail "feed should show the cancelled booking: $feed_ics"
pass "feed shows the booking as cancelled"

rebook=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_D" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"serviceId\":\"$SERVICE_ID\",\"startsAt\":\"$SLOT\"}" "$BASE_URL/api/bookings")
[ "$rebook" = "201" ] || fail "customer B should be able to take the freed slot, got $rebook"
pass "the cancelled slot is bookable again"

curl -fsS -b "$JAR_A" -X POST -H "origin: $BASE_URL" "$BASE_URL/api/provider/feed" >/dev/null || fail "feed rotate failed"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$FEED_PATH")
[ "$code" = "404" ] || fail "the old feed URL should stop working after a rotate, got $code"
pass "rotating the feed kills the old URL"

# ---------------------------------------------------------------------------
# Booking assistant (CI runs AI_PROVIDER=demo, so this is the recorded script through the real tool handlers).
# It only ever PROPOSES; the customer's confirm books, once, and only for the customer it was made for.
# ---------------------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"message":"anything Tuesday after 3?"}' "$BASE_URL/api/chat/$SLUG")
[ "$code" = "401" ] || fail "anonymous chat should be 401, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_D" -H 'content-type: application/json' -H 'origin: https://evil.example' \
  -d '{"message":"hi"}' "$BASE_URL/api/chat/$SLUG")
[ "$code" = "403" ] || fail "cross-origin chat should be 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"message":"hi"}' "$BASE_URL/api/chat/$SLUG")
[ "$code" = "400" ] || fail "a provider chatting with their own page should be 400, got $code"
pass "chat refuses anonymous, cross-origin and own-page callers"

chat=$(curl -fsS -b "$JAR_D" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"message":"anything Tuesday after 3?","timeZone":"America/Denver"}' "$BASE_URL/api/chat/$SLUG") || fail "assistant turn failed"
PROPOSAL_ID=$(printf '%s' "$chat" | json_field proposal.id) || fail "the assistant proposed nothing: $chat"
printf '%s' "$chat" | json_field proposal.status | grep -qx open || fail "proposal should be open: $chat"
printf '%s' "$chat" | json_field proposal.startsAt >/dev/null || fail "proposal card has no time: $chat"
pass "the assistant proposed a time (nothing booked yet)"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_C" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"proposalId\":\"$PROPOSAL_ID\"}" "$BASE_URL/api/bookings")
[ "$code" = "404" ] || fail "another customer confirming D's proposal should be 404, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_D" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"proposalId\":\"$PROPOSAL_ID\",\"startsAt\":\"2000-01-01T00:00:00Z\"}" "$BASE_URL/api/bookings")
[ "$code" = "400" ] || fail "a confirm that carries its own time should be 400, got $code"
pass "only the owner can confirm, and a confirm can't carry its own time"

confirmed=$(curl -fsS -b "$JAR_D" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"proposalId\":\"$PROPOSAL_ID\"}" "$BASE_URL/api/bookings") || fail "owner could not confirm the proposal"
printf '%s' "$confirmed" | json_field booking.status | grep -qx confirmed || fail "confirm should book: $confirmed"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_D" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"proposalId\":\"$PROPOSAL_ID\"}" "$BASE_URL/api/bookings")
[ "$code" = "409" ] || fail "a second confirm of the same proposal should be 409, got $code"
pass "confirm books once, then the proposal is spent"

history=$(curl -fsS -b "$JAR_D" "$BASE_URL/api/chat/$SLUG") || fail "chat history failed"
printf '%s' "$history" | json_field messages.1.proposal.status | grep -qx used || fail "history should show the card as used: $history"
history_c=$(curl -fsS -b "$JAR_C" "$BASE_URL/api/chat/$SLUG") || fail "customer C history failed"
printf '%s' "$history_c" | grep -q "$PROPOSAL_ID" && fail "another customer's history leaked the proposal"
pass "chat history is private and shows the spent card"

echo "SMOKE PASS"
