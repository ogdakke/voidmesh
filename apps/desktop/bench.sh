#!/bin/sh
# Desktop render benchmarks: the web app's bench scenarios on the desktop compositor, headless.
#
#   ./bench.sh                       every scenario, compared with the latest web record
#   ./bench.sh many-262144           scenarios whose id contains the text
#   WEB=path/to/web.json ./bench.sh  compare with one web record (bun run bench:render:record);
#                                    by default every latest.json under bench/results
#   SCALE=2 ./bench.sh               device pixels per point (the web's headless runs are at 1)
#   MODE=app ./bench.sh              the whole app frame through Rune (UI, layout), the GPU waited
#                                    on every frame, instead of the compositor alone
#
# By default each scenario runs the compositor alone (`bench::run_direct`), as the web's bench
# runs its renderer without React: frames submitted back to back (three in flight at most, as a
# swapchain allows), the GPU drained once a sample.
# Results go to target/bench/latest.jsonl, one scenario a line, and a table compares them with the
# web's: ms/frame (a sample's wall time over its frames), CPU p95 against the web renderer's CPU
# p95, and peak resident GPU bytes in the categories the web counts (processed, source and pooled
# textures), then the desktop's peak total with its decoded video and upload staging added (which
# the web keeps in the browser's GPU process). The web's rAF-paced scenarios report its throttled frame interval as
# ms/frame: compare CPU there.
set -eu
cd "$(dirname "$0")"
FILTER="${1:-}"
SCALE="${SCALE:-1}"
MODE="${MODE:-direct}"
WEB_DIR=../../bench/results
OUT=target/bench
mkdir -p "$OUT"

cargo build --release --quiet
BIN=target/release/voidmesh

# Synthetic H.264 clips for the video scenarios (the web draws its own into a canvas).
CLIP="$OUT/clip-1280x720.mp4"
[ -f "$CLIP" ] || ffmpeg -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30" -t 20 -pix_fmt yuv420p -c:v libx264 -g 30 "$CLIP"
CLIP_HD="$OUT/clip-1920x1080.mp4"
[ -f "$CLIP_HD" ] || ffmpeg -loglevel error -f lavfi -i "testsrc2=size=1920x1080:rate=30" -t 20 -pix_fmt yuv420p -c:v libx264 -g 30 "$CLIP_HD"

: > "$OUT/latest.jsonl"
for id in $(VOIDMESH_BENCH_LIST=1 "$BIN"); do
  case "$id" in *"$FILTER"*) ;; *) continue ;; esac
  frames=$(VOIDMESH_BENCH="$id" VOIDMESH_BENCH_FRAMES=1 "$BIN")
  video="$CLIP"
  case "$id" in video-*) video="$CLIP_HD" ;; esac
  if [ "$MODE" = app ]; then
    line=$(VOIDMESH_BENCH="$id" VOIDMESH_BENCH_VIDEO="$video" "$BIN" --scene bench --frames "$frames" --size 1280x720 --scale "$SCALE" 2>/dev/null | sed -n 's/^voidmesh-bench //p')
  else
    line=$(VOIDMESH_BENCH="$id" VOIDMESH_BENCH_VIDEO="$video" VOIDMESH_BENCH_DIRECT=1 VOIDMESH_BENCH_SCALE="$SCALE" "$BIN" 2>/dev/null | sed -n 's/^voidmesh-bench //p')
  fi
  if [ -z "$line" ]; then
    echo "$id: no result" >&2
    continue
  fi
  echo "$line" >> "$OUT/latest.jsonl"
  echo "$line" | jq -r '"\(.id): \(.msPerFrame*1000|round/1000) ms/frame, cpu p95 \(.cpuP95Ms*1000|round/1000) ms"'
done

WEB="${WEB:-}"
if [ -z "$WEB" ]; then
  # Every web record under bench/results (BENCH_OUT_DIR runs leave a latest.json each), the newest
  # result for a scenario winning.
  WEB=$(mktemp)
  find "$WEB_DIR" -name latest.json -print0 2>/dev/null | xargs -0 ls -tr 2>/dev/null | xargs cat 2>/dev/null \
    | jq -s '{results: (map(.results // []) | add // [] | group_by(.scenario.id // .id) | map(last))}' > "$WEB" || true
fi
[ -s "$WEB" ] || exit 0
jq -r --slurpfile d "$OUT/latest.jsonl" '
  def r: . * 1000 | round / 1000;
  (.results | map({key: (.scenario.id // .id), value: .}) | from_entries) as $web
  | ["scenario", "web ms/frame", "desktop ms/frame", "x", "web cpu p95", "desktop cpu p95", "x", "web peak MB", "desktop peak MB", "desktop total MB"],
    ($d[] | . as $x | $web[$x.id] as $w | select($w != null)
      | [$x.id, ($w.msPerFrame | r), ($x.msPerFrame | r), (($w.msPerFrame / ($x.msPerFrame + 1e-9)) * 10 | round / 10),
         ($w.cpuRenderP95Ms | r), ($x.cpuP95Ms | r), (($w.cpuRenderP95Ms / ($x.cpuP95Ms + 1e-9)) * 10 | round / 10),
         ($w.peakResidentBytes / 1048576 | round), ($x.peakResidentBytes / 1048576 | round), (($x.peakTotalBytes // 0) / 1048576 | round)])
  | @tsv' "$WEB" | column -t -s "$(printf '\t')"
