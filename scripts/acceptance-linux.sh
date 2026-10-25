#!/usr/bin/env bash
# Acceptance pass of the packaged .deb (task 10.2) in a debian:13 container (gate G-5 images):
# installs dist/*.deb with apt, then runs scripts/acceptance-driver.mjs as an unprivileged user on
# Xvfb with a window manager (openbox), with unprivileged user namespaces allowed (as on a
# desktop). The driver uses the host's Node.js and Playwright, mounted read-only.
#
# While the driver runs, tcpdump captures every frame on the container's network interface; no
# IP or IPv6 frame may come from the container itself (Veydr and the commands it starts send
# nothing; the kernel's ARP upkeep is recorded separately in arp.txt). As a
# positive control, the container first opens a TCP connection to 192.0.2.1 (TEST-NET-1), whose
# frames the same capture must show.
#
#   scripts/acceptance-linux.sh [image]    default debian:13
#
# Results: test-results/acceptance-linux/ (steps.jsonl, driver.log, eth0.pcap, packets.txt with
# every frame, control.txt and sent.txt with the container's own IP frames before and after the
# end of the control, arp.txt with its ARP frames).
# A passing run's steps.jsonl is copied to test/packaging/acceptance-linux-steps.jsonl (committed
# record, tied to the package by the SHA-256 in its first step).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--inside" ]]; then
  # ---- runs inside the container, as root ----
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq xvfb xauth openbox wmctrl xdotool tcpdump procps >/dev/null
  apt-get install -y -qq /dist/*.deb > /results/deb-install.log 2>&1
  useradd -m -s /bin/bash acceptance
  chown acceptance /results
  (cd /dist && sha256sum *.deb) > /results/deb.sha256

  # Package downloads are done; from here on the container itself has nothing to send.
  tcpdump -i eth0 -n -U -w /results/eth0.pcap 2> /results/tcpdump.log &
  capture=$!
  sleep 2
  timeout 3 bash -c 'exec 3<>/dev/tcp/192.0.2.1/80' 2>/dev/null || true
  sleep 1
  boundary=$(date +%s.%N)

  status=0
  runuser -u acceptance -- env -i HOME=/home/acceptance USER=acceptance SHELL=/bin/bash PATH=/usr/local/bin:/usr/bin:/bin \
    RESULTS=/results NODE_BIN=/node/bin/node REPO=/repo \
    bash -c 'Xvfb :99 -screen 0 1440x900x24 -nolisten tcp & export DISPLAY=:99; sleep 1; openbox & sleep 1; /node/bin/node /repo/scripts/acceptance-driver.mjs' \
    > /results/driver.log 2>&1 || status=$?

  sleep 2
  kill "$capture"
  wait "$capture" || true
  # The bridge also carries the Docker host's own multicast (e.g. its mDNS service browsing), so
  # only frames with this container's MAC address as source count.
  mac=$(cat /sys/class/net/eth0/address)
  tcpdump -r /results/eth0.pcap -n -e -tt > /results/packets.txt 2>/dev/null || true
  # IP and IPv6 frames only: the kernel's own ARP upkeep (e.g. re-checking the gateway a few
  # seconds after the control used it) carries no data; any traffic would also appear as IP.
  tcpdump -r /results/eth0.pcap -n -e -tt "ether src $mac and (ip or ip6)" > /results/own.txt 2>/dev/null || true
  tcpdump -r /results/eth0.pcap -n -e -tt "ether src $mac and arp" > /results/arp.txt 2>/dev/null || true
  awk -v b="$boundary" '$1 < b' /results/own.txt > /results/control.txt
  awk -v b="$boundary" '$1 >= b' /results/own.txt > /results/sent.txt
  echo "driver exit $status; frames on eth0: $(wc -l < /results/packets.txt); IP frames sent by this container ($mac): control $(wc -l < /results/control.txt), during the run $(wc -l < /results/sent.txt); its ARP frames: $(wc -l < /results/arp.txt)"
  [[ -s /results/control.txt ]] || { echo "positive control not captured" >&2; exit 3; }
  exit "$status"
fi

# ---- runs on the host ----
image="${1:-debian:13}"
ls "$root"/dist/*.deb > /dev/null || { echo "run npm run dist:linux first" >&2; exit 2; }
node_root="$(dirname "$(dirname "$(command -v node)")")"
results="$root/test-results/acceptance-linux"
rm -rf "$results"
mkdir -p "$results"

docker run --rm --security-opt seccomp=unconfined --cap-add NET_RAW --cap-add NET_ADMIN --shm-size 1g \
  -v "$root/dist:/dist:ro" -v "$root:/repo:ro" -v "$node_root:/node:ro" -v "$results:/results" \
  "$image" bash /repo/scripts/acceptance-linux.sh --inside 2>&1 | tee "$results/container.log"
status=${PIPESTATUS[0]}
sent=$(wc -l < "$results/sent.txt")
control=$(wc -l < "$results/control.txt")
echo "acceptance: driver/container exit $status, control frames $control, IP frames sent by the container during the run: $sent"
[[ "$status" -eq 0 && "$control" -gt 0 && "$sent" -eq 0 ]] || exit 1
cp "$results/steps.jsonl" "$root/test/packaging/acceptance-linux-steps.jsonl"
echo "record copied to test/packaging/acceptance-linux-steps.jsonl"
