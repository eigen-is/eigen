#!/bin/sh
# A command on PATH (the default CMD, `sh`, `bun …`) runs as given; anything else is a CLI subcommand.
case "$(command -v "$1" 2>/dev/null)" in
    /*) exec "$@" ;;
esac
exec bun /app/apps/api/src/cli/index.ts "$@"
