#!/usr/bin/env bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
appside_up
lan_dummy_up
sleep 2
podman ps --format '{{.Names}}\t{{.Networks}}\t{{.Status}}' | grep "^${P}-"
