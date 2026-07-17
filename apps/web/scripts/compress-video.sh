#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [-a|--audio] [-e encoding] [-o outdir] [-c crf_av1] [-x crf_h264] [-f fps] file [file ...]"
  echo ""
  echo "Options:"
  echo "  -a, --audio  Preserve audio by encoding it as AAC (default: strip audio)"
  echo "  -e, --encoding  Output encoding: av1, h264, or h.264 (repeatable; default: av1 and h264)"
  echo "  -o  Output directory (default: same directory as input)"
  echo "  -c  AV1 CRF value (default: 50)"
  echo "  -x  H.264 CRF value (default: 28)"
  echo "  -f  Target fps (default: preserve original fps)"
  exit 1
}

outdir=""
crf_av1=50
crf_h264=28
fps=""
keep_audio=0
inputs=()
encodings=()
selected_av1=0
selected_h264=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a | --audio)
      keep_audio=1
      shift
      ;;
    -e | --encoding)
      [ $# -ge 2 ] || usage
      case "$2" in
        av1)
          selected_av1=1
          ;;
        h264 | h.264)
          selected_h264=1
          ;;
        *)
          echo "Unsupported encoding: $2" >&2
          usage
          ;;
      esac
      shift 2
      ;;
    -o)
      [ $# -ge 2 ] || usage
      outdir="$2"
      shift 2
      ;;
    -c)
      [ $# -ge 2 ] || usage
      crf_av1="$2"
      shift 2
      ;;
    -x)
      [ $# -ge 2 ] || usage
      crf_h264="$2"
      shift 2
      ;;
    -f)
      [ $# -ge 2 ] || usage
      fps="$2"
      shift 2
      ;;
    -h | --help)
      usage
      ;;
    --)
      shift
      inputs+=("$@")
      break
      ;;
    -*)
      usage
      ;;
    *)
      inputs+=("$1")
      shift
      ;;
  esac
done

if [ ${#inputs[@]} -eq 0 ]; then
  usage
fi

if [ "$selected_av1" -eq 0 ] && [ "$selected_h264" -eq 0 ]; then
  encodings=(av1 h264)
else
  [ "$selected_av1" -eq 1 ] && encodings+=(av1)
  [ "$selected_h264" -eq 1 ] && encodings+=(h264)
fi

for input in "${inputs[@]}"; do
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
  for encoding in "${encodings[@]}"; do
    case "$encoding" in
      av1) echo "  AV1  -> $av1_out" ;;
      h264) echo "  H264 -> $h264_out" ;;
    esac
  done

  if [ "$keep_audio" -eq 1 ]; then
    audio_args=(-c:a aac -b:a 160k)
  else
    audio_args=(-an)
  fi

  for encoding in "${encodings[@]}"; do
    case "$encoding" in
      av1)
        if [ -n "$fps" ]; then
          if ffmpeg -y -i "$input" -c:v libsvtav1 -crf "$crf_av1" -b:v 0 "${audio_args[@]}" -vf "fps=$fps" "$av1_out"; then
            echo "  AV1  done ($(du -h "$av1_out" | cut -f1 | xargs))"
          else
            echo "  AV1  FAILED" >&2
          fi
        else
          if ffmpeg -y -i "$input" -c:v libsvtav1 -crf "$crf_av1" -b:v 0 "${audio_args[@]}" "$av1_out"; then
            echo "  AV1  done ($(du -h "$av1_out" | cut -f1 | xargs))"
          else
            echo "  AV1  FAILED" >&2
          fi
        fi
        ;;
      h264)
        if [ -n "$fps" ]; then
          if ffmpeg -y -i "$input" -c:v libx264 -crf "$crf_h264" -preset slow "${audio_args[@]}" -vf "fps=$fps" "$h264_out"; then
            echo "  H264 done ($(du -h "$h264_out" | cut -f1 | xargs))"
          else
            echo "  H264 FAILED" >&2
          fi
        else
          if ffmpeg -y -i "$input" -c:v libx264 -crf "$crf_h264" -preset slow "${audio_args[@]}" "$h264_out"; then
            echo "  H264 done ($(du -h "$h264_out" | cut -f1 | xargs))"
          else
            echo "  H264 FAILED" >&2
          fi
        fi
        ;;
    esac
  done
  echo ""
done
