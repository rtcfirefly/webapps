#!/bin/bash
# runs-in: host
# Build (if needed) and run the screenshot container. Nothing here executes
# anything fetched from the network: the image install is pacman-verified at
# build time, and the run itself is offline.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${REPO_DIR:-$(cd "$HERE/../.." && pwd)}"
OUT="${OUT_DIR:-$HERE/out}"
IMAGE="${IMAGE:-video-delay-shots}"

if ! podman image exists "$IMAGE"; then
  # The habit-tracker image carries exactly this toolchain (chromium, python,
  # emoji fonts, writable HOME) and runs whatever shoot.py is mounted at /tools,
  # so it stands in when Docker Hub is unreachable and ours has not been built.
  if [ "$IMAGE" = "video-delay-shots" ] && podman image exists localhost/habit-tracker-shots; then
    echo "note: using localhost/habit-tracker-shots (same toolchain); build ours with: $0 build" >&2
    IMAGE=localhost/habit-tracker-shots
  else
    echo "Building $IMAGE ..." >&2
    base_arg=()
    [ -n "${BASE:-}" ] && base_arg=(--build-arg "BASE=$BASE")
    podman build -t "$IMAGE" "${base_arg[@]}" -f "$HERE/Dockerfile" "$HERE"
  fi
fi
[ "${1:-}" = "build" ] && exit 0

mkdir -p "$OUT"
extra=(--pids-limit 1024 --memory 3g --userns=keep-id)
[ "${OFFLINE:-1}" = "1" ] && extra+=(--network none)
if [ "${HARDENED:-1}" = "1" ]; then
  extra+=(--cap-drop=ALL --security-opt=no-new-privileges)
fi

exec podman run --rm \
  -v "$REPO:/repo:ro" \
  -v "$HERE:/tools:ro" \
  -v "$OUT:/out" \
  "${extra[@]}" \
  "$IMAGE" "$@"
