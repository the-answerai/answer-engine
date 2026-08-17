#!/usr/bin/env sh
set -eu

attempt=1
while [ "$attempt" -le 60 ]; do
  if docker compose exec -T postgres sh -c \
    'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "The Compose PostgreSQL service did not become ready" >&2
exit 1
