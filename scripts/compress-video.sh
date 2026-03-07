#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [-o outdir] [-c crf_av1] [-x crf_h264] [-f fps] file [file ...]"
  echo ""
  echo "Options:"
  echo "  -o  Output directory (default: same directory as input)"
  echo "  -c  AV1 CRF value (default: 50)"
  echo "  -x  H.264 CRF value (default: 28)"
  echo "  -f  Target fps (default: 30)"
  exit 1
}

outdir=""
crf_av1=50
crf_h264=28
fps=30

while getopts "o:c:x:f:h" opt; do
  case $opt in
    o) outdir="$OPTARG" ;;
    c) crf_av1="$OPTARG" ;;
    x) crf_h264="$OPTARG" ;;
    f) fps="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))

if [ $# -eq 0 ]; then
  usage
fi

for input in "$@"; do
  if [ ! -f "$input" ]; then
    echo "File not found: $input" >&2
    continue
  fi

  dir="${outdir:-$(dirname "$input")}"
  mkdir -p "$dir"
  name="$(basename "${input%.*}")"

  av1_out="$dir/${name}_av1_qp${crf_av1}.mp4"
  h264_out="$dir/${name}_compressed.mp4"

  echo "Compressing: $input"
  echo "  AV1  -> $av1_out"
  echo "  H264 -> $h264_out"

  ffmpeg -y -i "$input" -c:v libsvtav1 -crf "$crf_av1" -b:v 0 -an -vf "fps=$fps" "$av1_out" 2>/dev/null &
  pid_av1=$!

  ffmpeg -y -i "$input" -c:v libx264 -crf "$crf_h264" -preset slow -an -vf "fps=$fps" "$h264_out" 2>/dev/null &
  pid_h264=$!

  wait $pid_av1 && echo "  AV1  done ($(du -h "$av1_out" | cut -f1 | xargs))" || echo "  AV1  FAILED" >&2
  wait $pid_h264 && echo "  H264 done ($(du -h "$h264_out" | cut -f1 | xargs))" || echo "  H264 FAILED" >&2
  echo ""
done
