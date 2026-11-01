#!/usr/bin/env bash
# Container entry point: make sure the Hodos bundles are in the Harness profile
# (the Harness home is a volume, so this runs at every start and is safe to repeat),
# then serve.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
"$here/install.sh" plugins
exec "$here/serve.sh"
