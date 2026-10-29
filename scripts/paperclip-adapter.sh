#!/usr/bin/env bash
#
# Install, reload, inspect or remove this adapter in a local Paperclip instance.
#
# Everything here goes through Paperclip's own adapter HTTP API. Nothing writes
# to the Paperclip install directory or its database directly.
#
# Usage:
#   scripts/paperclip-adapter.sh install   [api-base]
#   scripts/paperclip-adapter.sh reload    [api-base]
#   scripts/paperclip-adapter.sh status    [api-base]
#   scripts/paperclip-adapter.sh disable   [api-base]
#   scripts/paperclip-adapter.sh enable    [api-base]
#   scripts/paperclip-adapter.sh uninstall [api-base]
#
# api-base defaults to http://127.0.0.1:3100/api (the default local instance).

set -euo pipefail

ADAPTER_TYPE="qoder_local"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-status}"
API_BASE="${2:-${PAPERCLIP_API_BASE:-http://127.0.0.1:3100/api}}"

require_server() {
  if ! curl -fsS --max-time 8 "${API_BASE}/health" >/dev/null 2>&1; then
    echo "Cannot reach Paperclip at ${API_BASE}." >&2
    echo "Start it (\`paperclipai run\`) or pass a different api-base." >&2
    exit 1
  fi
}

case "${ACTION}" in
  install)
    require_server
    # The adapter must be built: the host loads ./dist/index.js from this path.
    if [ ! -f "${PROJECT_DIR}/dist/index.js" ]; then
      echo "dist/ is missing. Run \`npm run build\` first." >&2
      exit 1
    fi
    curl -fsS --max-time 120 -X POST "${API_BASE}/adapters/install" \
      -H "Content-Type: application/json" \
      -d "$(PROJECT_DIR="${PROJECT_DIR}" node -e 'process.stdout.write(JSON.stringify({packageName:process.env.PROJECT_DIR,isLocalPath:true}))')"
    echo
    ;;

  reload)
    require_server
    curl -fsS --max-time 60 -X POST "${API_BASE}/adapters/${ADAPTER_TYPE}/reload"
    echo
    echo "Reload refreshed the bundled adapter. Restart the server only if" >&2
    echo "shared runtime dependencies such as adapter-utils changed." >&2
    ;;

  status)
    require_server
    curl -fsS --max-time 10 "${API_BASE}/adapters/${ADAPTER_TYPE}"
    echo
    ;;

  disable)
    require_server
    curl -fsS --max-time 30 -X PATCH "${API_BASE}/adapters/${ADAPTER_TYPE}" \
      -H "Content-Type: application/json" -d '{"disabled":true}'
    echo
    ;;

  enable)
    require_server
    curl -fsS --max-time 30 -X PATCH "${API_BASE}/adapters/${ADAPTER_TYPE}" \
      -H "Content-Type: application/json" -d '{"disabled":false}'
    echo
    ;;

  uninstall)
    require_server
    # Agents already configured with this adapter type keep their rows; they
    # simply have no harness until the adapter is installed again.
    curl -fsS --max-time 60 -X DELETE "${API_BASE}/adapters/${ADAPTER_TYPE}"
    echo
    ;;

  *)
    echo "Unknown action: ${ACTION}" >&2
    echo "Use: install | reload | status | disable | enable | uninstall" >&2
    exit 2
    ;;
esac
