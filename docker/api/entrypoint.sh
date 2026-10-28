#!/bin/sh
# Every container of the API image starts here, the server and each CLI run alike. It closes the data folder to every
# other user of the host, then runs a command on PATH (the default CMD, `sh`, `bun …`) as given, and anything else as
# a CLI subcommand.

# data/ holds every secret of the server, and a folder made by hand or by an older setup is open to every user. Only
# its owner, the API's user, sets the mode, so a CLI run as root or as the operator leaves it alone.
if [ -n "${EIGEN_DATA_ROOT:-}" ] && [ -O "$EIGEN_DATA_ROOT" ]; then chmod 0700 "$EIGEN_DATA_ROOT"; fi

case "$(command -v "$1" 2>/dev/null)" in
    /*) exec "$@" ;;
esac
exec bun /app/apps/api/src/cli/index.ts "$@"
