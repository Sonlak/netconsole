#!/bin/sh
# Host SSH/REST cannot hairpin into privileged sim containers on Docker Desktop.
# Forward published ports to device mgmt addresses on lab-net.
set -eu

fwd() {
  listen="$1"
  target="$2"
  echo "[port-gw] :${listen} -> ${target}"
  socat TCP-LISTEN:"${listen}",fork,reuseaddr TCP:"${target}" &
}

fwd 2221 sw-core-01:22
fwd 8441 sw-core-01:8443
fwd 2222 sw-core-02:22
fwd 8442 sw-core-02:8443
fwd 2223 sw-ds-01:22
fwd 8443 sw-ds-01:8443
fwd 2224 sw-ds-02:22
fwd 8444 sw-ds-02:8443
fwd 2225 sw-as-01:22
fwd 8445 sw-as-01:8443
fwd 2226 sw-as-02:22
fwd 8446 sw-as-02:8443

wait
