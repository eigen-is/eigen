#!/usr/bin/env bash
# The boot check publish.yml runs on an arm64 runner before it publishes a release: publish.yml's candidate images, in a
# registry:2 of this run under the release they become, installed with mail off from a docker:cli container that has no
# Bun, answer /eigen/health. The release gate proves the rest on amd64.
#
# Usage:  CANDIDATE=candidate-<version or main>-<platform> ./docker/test-boot.sh
# Needs:  docker, curl, git, and ghcr.io.

set -euo pipefail

. "$(dirname "$0")/probe-lib.sh"

if [ -z "${CANDIDATE:-}" ]; then
    echo "harness: CANDIDATE names no candidate, such as candidate-main-arm64" >&2
    exit 1
fi
# What bootstrap pins, the version or main.
TARGET=${CANDIDATE#candidate-}
TARGET=${TARGET%-*}

scratch_init boot
# A release install pulls its images; the private build tags of a local build do not apply.
for name in $IMAGES; do unset "$(image_key "$name")"; done
registry_init

header "Booting $CANDIDATE as $TARGET"
started=$SECONDS
if ! copy_candidate "$CANDIDATE" "$TARGET"; then
    abort "no $CANDIDATE on $PUBLISHED_REGISTRY after 40 minutes"
fi
# The install must pull what it runs.
remove_registry_images
ok "copied $CANDIDATE into the registry on port $REGISTRY_PORT in $((SECONDS - started))s"

# A candidate names ghcr.io: this run's registry is a mirror.
release_install "eigentest-boot-$$" "$TARGET" "$REGISTRY" --mirror
run_setup "$SCRATCH/setup.log" --yes --mail-domain example.org --no-mail --no-relay --no-proxy \
    --contact-email admin@example.org --domain localhost
if stack_up && [ "$(env_of EIGEN_VERSION)" = "$TARGET" ] && env_of EIGEN_API_IMAGE | grep -q "^$REGISTRY/api@sha256:"; then
    ok "every service runs, eigen-api is healthy, and .env.production pins $TARGET by digest"
else
    fail "the install: EIGEN_VERSION=$(env_of EIGEN_VERSION), $(env_of EIGEN_API_IMAGE)"
    dc ps -a 2>&1 | sed 's/^/    /' || true
fi
probe "/eigen/health" "https://localhost:$PORT_HTTPS/eigen/health" 200 OK

header "Result"
probe_summary
