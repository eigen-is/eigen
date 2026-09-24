#!/usr/bin/env bash
# Runs every docker/ harness in turn and prints one line per harness. Each one installs into its own
# scratch folder and cleans up after itself.
#
# Usage:  ./docker/test-all.sh
# Needs:  what the harnesses need: docker, curl, nc, openssl, git, expect.

set -uo pipefail

cd "$(dirname "$0")"

results=()
failed=0
for harness in test-launcher.sh test-cli.sh test-interactive.sh test-release.sh test-deployments.sh test-host-proxies.sh \
    test-mail-hardening.sh; do
    printf '\n##### %s #####\n' "$harness"
    started=$SECONDS
    if "./$harness"; then
        results+=("✓ $harness ($((SECONDS - started))s)")
    else
        results+=("✗ $harness ($((SECONDS - started))s)")
        failed=1
    fi
done

printf '\n=== Summary ===\n'
printf '  %s\n' "${results[@]}"
exit "$failed"
