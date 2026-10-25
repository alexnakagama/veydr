#!/usr/bin/env bash
# Packaging smoke test on Linux distributions (task 9.5, gate G-5). Runs the packages in dist/
# (`npm run dist:linux`) in Docker containers under Xvfb, as an unprivileged user:
#
#   scripts/smoke-linux.sh                     all distributions
#   scripts/smoke-linux.sh ubuntu:24.04 ...    only these images
#
# Each distribution runs twice:
#   userns    unprivileged user namespaces allowed (`--security-opt seccomp=unconfined`), as on a
#             typical desktop (but not Ubuntu 24.04's AppArmor restriction, which needs a real host)
#   no-userns Docker's default seccomp profile, which refuses them (chrome-sandbox setuid path)
#
# Checks (each PASS, FAIL, EXPECTED-FAIL when the documented behavior is a failure, or NOT-TESTABLE
# when the container itself prevents the check):
#   deb                 apt install of the .deb, then `veydr --smoke-test` (Debian/Ubuntu only);
#                       NOT-TESTABLE without user namespaces: Docker withholds CAP_SYS_ADMIN, which
#                       the setuid chrome-sandbox needs
#   deb-sandbox-mode    chrome-sandbox mode chosen by the post-install script (0755 / 4755)
#   appimage-no-fuse    the AppImage without libfuse2: EXPECTED-FAIL (it cannot mount itself)
#   appimage-extract    the AppImage with APPIMAGE_EXTRACT_AND_RUN=1; EXPECTED-FAIL without user
#                       namespaces (its launcher adds --no-sandbox, which Veydr refuses); NOT-TESTABLE
#                       if the Docker host lets the no-userns container create them anyway
#
# Results: test-results/smoke-linux/<image>-<mode>.log and summary.txt. Exit status 0 only if
# every check matches its expectation.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--inside" ]]; then
  # ---- runs inside the container, as root ----
  mode="$2"
  family="$3"
  out=/results/checks.txt
  : > "$out"
  record() { echo "$1 $2 $3" >> "$out"; echo "== $1: $2 ($3)"; }
  smoke_ok() { grep -o 'VEYDR_SMOKE_TEST .*' "$1" | grep -q '"result":"pass"'; }

  # Runtime libraries for the AppImage (the .deb declares its own).
  if [[ "$family" == "debian" ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq xvfb xauth >/dev/null
  else
    dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth gtk3 nss alsa-lib cups-libs libXScrnSaver libXtst mesa-libgbm at-spi2-core util-linux procps-ng >/dev/null
  fi
  useradd -m smoke
  cat /etc/os-release > /results/os-release
  (ldd --version 2>&1 || true) | head -1 > /results/glibc

  deb=$(ls /dist/*.deb)
  appimage=$(ls /dist/*.AppImage)
  cp "$appimage" /home/smoke/Veydr.AppImage
  chown smoke /home/smoke/Veydr.AppImage
  chmod +x /home/smoke/Veydr.AppImage

  as_smoke() { runuser -u smoke -- env HOME=/home/smoke "$@"; }

  if [[ "$family" == "debian" ]]; then
    if apt-get install -y -qq "$deb" > /results/deb-install.log 2>&1; then
      sandbox_mode=$(stat -c '%a' /opt/Veydr/chrome-sandbox)
      if [[ "$mode" == "userns" && "$sandbox_mode" == "755" ]] || [[ "$mode" == "no-userns" && "$sandbox_mode" == "4755" ]]; then
        record deb-sandbox-mode PASS "chrome-sandbox $sandbox_mode"
      else
        record deb-sandbox-mode FAIL "chrome-sandbox $sandbox_mode"
      fi
      if as_smoke timeout 120 xvfb-run -a veydr --smoke-test > /results/deb-smoke.log 2>&1 && smoke_ok /results/deb-smoke.log; then
        record deb PASS "smoke test passed"
      elif [[ "$mode" == "no-userns" ]] && grep -q 'Failed to move to new namespace' /results/deb-smoke.log; then
        # The setuid helper runs as root but without CAP_SYS_ADMIN, which Docker withholds; on a
        # real host without user namespaces root has it. Not a result about the package.
        record deb NOT-TESTABLE "setuid chrome-sandbox needs CAP_SYS_ADMIN, which the container lacks"
      else
        record deb FAIL "see deb-smoke.log"
      fi
    else
      record deb FAIL "apt install failed, see deb-install.log"
    fi
  else
    record deb N/A "no .deb on this distribution"
  fi

  # libfuse2 is not installed in these images, as on recent distributions by default.
  if as_smoke timeout 120 xvfb-run -a /home/smoke/Veydr.AppImage --smoke-test > /results/appimage-no-fuse.log 2>&1; then
    record appimage-no-fuse FAIL "ran although libfuse2 is missing"
  elif grep -qi 'fuse' /results/appimage-no-fuse.log; then
    record appimage-no-fuse EXPECTED-FAIL "needs libfuse2 (FUSE 2) to mount itself"
  else
    record appimage-no-fuse FAIL "failed for another reason, see appimage-no-fuse.log"
  fi

  if as_smoke env APPIMAGE_EXTRACT_AND_RUN=1 timeout 180 xvfb-run -a /home/smoke/Veydr.AppImage --smoke-test > /results/appimage-extract.log 2>&1 && smoke_ok /results/appimage-extract.log; then
    if [[ "$mode" == "userns" ]]; then
      record appimage-extract PASS "smoke test passed"
    else
      # Whether Docker's default seccomp profile blocks user namespaces depends on the Docker host.
      record appimage-extract NOT-TESTABLE "this Docker host allows user namespaces despite the default seccomp profile"
    fi
  elif [[ "$mode" == "no-userns" ]] && grep -o 'VEYDR_SMOKE_TEST .*' /results/appimage-extract.log | grep -q '"name":"process-sandbox","ok":false'; then
    record appimage-extract EXPECTED-FAIL "no user namespaces: launcher adds --no-sandbox, Veydr refuses"
  else
    record appimage-extract FAIL "see appimage-extract.log"
  fi
  exit 0
fi

# ---- runs on the host ----
images=("$@")
if [[ ${#images[@]} -eq 0 ]]; then
  images=(ubuntu:22.04 ubuntu:24.04 debian:12 debian:13 fedora:44)
fi
ls "$root"/dist/*.deb "$root"/dist/*.AppImage > /dev/null || { echo "run npm run dist:linux first" >&2; exit 2; }

results="$root/test-results/smoke-linux"
mkdir -p "$results"
summary="$results/summary.txt"
: > "$summary"
failed=0

for image in "${images[@]}"; do
  case "$image" in
    fedora*) family=fedora ;;
    *) family=debian ;;
  esac
  for mode in userns no-userns; do
    name="${image//[:\/]/-}-$mode"
    dir="$results/$name"
    rm -rf "$dir"
    mkdir -p "$dir"
    security=()
    [[ "$mode" == "userns" ]] && security=(--security-opt seccomp=unconfined)
    echo "### $image ($mode)"
    if ! docker run --rm "${security[@]}" \
      -v "$root/dist:/dist:ro" -v "$root/scripts/smoke-linux.sh:/smoke-linux.sh:ro" -v "$dir:/results" \
      "$image" bash /smoke-linux.sh --inside "$mode" "$family" > "$dir/container.log" 2>&1; then
      echo "$image $mode container FAIL see container.log" | tee -a "$summary"
      failed=1
      continue
    fi
    version=$(. "$dir/os-release" && echo "$PRETTY_NAME")
    glibc=$(cat "$dir/glibc")
    while read -r check status detail; do
      echo "$image $mode $check $status $detail [$version; $glibc]" | tee -a "$summary"
      [[ "$status" == "FAIL" ]] && failed=1
    done < "$dir/checks.txt"
  done
done

echo
echo "Summary written to $summary"
exit $failed
