#!/bin/bash
# Stress test: rapid navigation to reproduce renderer crash
# Tests fast sequential navigations that cause cross-process renderer swaps

BASE="http://localhost:8222/api/v1"

# Diverse URLs to trigger cross-process navigations
URLS=(
  "https://www.google.com"
  "https://www.amazon.com"
  "https://www.wikipedia.org"
  "https://github.com"
  "https://www.reddit.com"
  "https://news.ycombinator.com"
  "https://www.nytimes.com"
  "https://www.bbc.com"
  "https://www.ebay.com"
  "https://stackoverflow.com"
  "https://www.apple.com"
  "https://www.microsoft.com"
  "https://www.youtube.com"
  "https://www.cnn.com"
  "https://www.espn.com"
)

NUM_URLS=${#URLS[@]}

echo "=== ABP Fast Navigation Stress Test ==="
echo ""

# Create a fresh tab
echo "Creating tab..."
TAB_ID=$(curl -s -X POST "$BASE/tabs" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")

if [ -z "$TAB_ID" ]; then
  echo "FATAL: Could not create tab"
  exit 1
fi
echo "Tab: $TAB_ID"
echo ""

# Test 1: Rapid sequential navigations (wait for each response)
echo "=== Test 1: Rapid sequential navigations (20 navigations) ==="
FAILURES=0
for i in $(seq 0 19); do
  idx=$((i % NUM_URLS))
  url="${URLS[$idx]}"
  START=$(python3 -c "import time; print(int(time.time()*1000))")

  RESULT=$(curl -s --max-time 60 -X POST "$BASE/tabs/$TAB_ID/navigate" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"$url\"}" 2>&1)

  END=$(python3 -c "import time; print(int(time.time()*1000))")
  ELAPSED=$((END - START))

  # Check if result contains success indicator
  STATUS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('status','FAIL'))" 2>/dev/null || echo "ERROR")

  if [ "$STATUS" = "navigated" ]; then
    echo "  [$((i+1))/20] OK  ${ELAPSED}ms -> $url"
  else
    FAILURES=$((FAILURES + 1))
    echo "  [$((i+1))/20] FAIL ${ELAPSED}ms -> $url"
    echo "           $(echo "$RESULT" | head -c 200)"
  fi
done
echo "  Failures: $FAILURES/20"
echo ""

# Check tab health
echo "=== Tab health check ==="
curl -s "$BASE/tabs" | python3 -c "
import sys,json
tabs = json.load(sys.stdin)
for t in tabs:
    print(f'  {t[\"id\"][:8]}... active={t.get(\"active\")} url={t.get(\"url\",\"\")[:60]}')" 2>/dev/null
echo ""

# Test 2: Fire-and-forget navigations (don't wait for response before sending next)
echo "=== Test 2: Overlapping navigations (5 concurrent) ==="
PIDS=""
for i in $(seq 0 4); do
  url="${URLS[$i]}"
  curl -s --max-time 60 -X POST "$BASE/tabs/$TAB_ID/navigate" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"$url\"}" > "/tmp/nav_result_$i.json" 2>&1 &
  PIDS="$PIDS $!"
  echo "  Fired navigate to $url (pid $!)"
done
echo "  Waiting for all to complete..."
for pid in $PIDS; do
  wait $pid 2>/dev/null
done
echo "  All done. Results:"
for i in $(seq 0 4); do
  STATUS=$(python3 -c "import json; d=json.load(open('/tmp/nav_result_$i.json')); print(d.get('result',{}).get('status','FAIL'))" 2>/dev/null || echo "ERROR")
  echo "    [$i] $STATUS"
done
echo ""

# Test 3: Navigate then immediately navigate again (interrupt pattern)
echo "=== Test 3: Navigate-interrupt pattern (navigate during load) ==="
for i in $(seq 0 4); do
  first_url="${URLS[$((i * 2 % NUM_URLS))]}"
  second_url="${URLS[$(( (i * 2 + 1) % NUM_URLS))]}"

  # Fire first nav in background (don't wait)
  curl -s --max-time 60 -X POST "$BASE/tabs/$TAB_ID/navigate" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"$first_url\"}" > /dev/null 2>&1 &
  FIRST_PID=$!

  # Immediately fire second nav (while first is still processing)
  sleep 0.1  # tiny delay to ensure first request is in-flight
  RESULT=$(curl -s --max-time 60 -X POST "$BASE/tabs/$TAB_ID/navigate" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"$second_url\"}" 2>&1)

  STATUS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('status','FAIL'))" 2>/dev/null || echo "ERROR")
  echo "  [$((i+1))/5] First: $first_url -> Second: $second_url => $STATUS"

  wait $FIRST_PID 2>/dev/null
done
echo ""

# Final health check
echo "=== Final health check ==="
TABS=$(curl -s "$BASE/tabs")
echo "Tabs: $TABS" | python3 -c "
import sys,json
tabs = json.load(sys.stdin)
print(f'  {len(tabs)} tab(s)')
for t in tabs:
    print(f'  {t[\"id\"][:8]}... active={t.get(\"active\")} url={t.get(\"url\",\"\")[:60]}')" 2>/dev/null || echo "  Tab list: $(echo "$TABS" | head -c 200)"

# Final navigation to confirm tab is still usable
echo ""
echo "=== Recovery: final navigate ==="
RESULT=$(curl -s --max-time 60 -X POST "$BASE/tabs/$TAB_ID/navigate" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' 2>&1)
STATUS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('status','FAIL'))" 2>/dev/null || echo "ERROR")
echo "  Result: $STATUS"

echo ""
echo "=== Stress test complete ==="
