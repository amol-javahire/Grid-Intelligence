#!/usr/bin/env bash
# Wrapper: source .env then exec the api-server
# PM2 manages this process — do not add set -e (it would exit on any non-zero)
set -a
# shellcheck source=/dev/null
source "$(dirname "$0")/../.env"
set +a

exec node --enable-source-maps \
  "$(dirname "$0")/../artifacts/api-server/dist/index.mjs" "$@"
