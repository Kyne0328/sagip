#!/usr/bin/env bash
set -euo pipefail

# GitHub-runner test credentials exist only for this disposable container.
# Never connect this gate to the deployed database or print its connection URL.
: "${GITHUB_ENV:?This helper is for the GitHub validation runner}"
export POSTGRES_PASSWORD
POSTGRES_PASSWORD="$(openssl rand -hex 32)"
echo "::add-mask::$POSTGRES_PASSWORD"
docker run --detach --name sagip-test-postgres \
  --env POSTGRES_PASSWORD --env POSTGRES_USER=sagip_test --env POSTGRES_DB=sagip_test \
  --publish 127.0.0.1:55432:5432 \
  --health-cmd 'pg_isready -U sagip_test -d sagip_test' \
  --health-interval 2s --health-timeout 2s --health-retries 30 \
  postgres:18
for attempt in {1..30}; do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' sagip-test-postgres)" == healthy ]]; then
    printf 'SAGIP_TEST_DATABASE_URL=postgresql://sagip_test:%s@127.0.0.1:55432/sagip_test\n' "$POSTGRES_PASSWORD" >> "$GITHUB_ENV"
    exit 0
  fi
  sleep 2
done
echo 'Disposable PostgreSQL failed its readiness gate' >&2
exit 1
