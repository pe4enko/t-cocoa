#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE=${COMPOSE_FILE:-"$SCRIPT_DIR/compose.ghcr.yaml"}
ENV_FILE=${ENV_FILE:-"$SCRIPT_DIR/.env"}
PRUNE_OLD_IMAGES=${PRUNE_OLD_IMAGES:-false}

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "Docker Compose is not installed. Install 'docker compose' plugin or 'docker-compose'." >&2
  exit 1
fi

echo "Using compose command: $COMPOSE_CMD"
echo "Using compose file: $COMPOSE_FILE"

$COMPOSE_CMD -f "$COMPOSE_FILE" pull
$COMPOSE_CMD -f "$COMPOSE_FILE" up -d

if [ "$PRUNE_OLD_IMAGES" = "true" ]; then
  docker image prune -f >/dev/null
fi

$COMPOSE_CMD -f "$COMPOSE_FILE" ps
