FROM alpine:3.22

# The capability lets the unbound user bind :53 whatever the engine's unprivileged-port range.
RUN apk add --no-cache unbound drill libcap-utils \
    && setcap cap_net_bind_service=+ep /usr/sbin/unbound

COPY unbound.conf /etc/unbound/unbound.conf

ARG EIGEN_VERSION
ARG EIGEN_COMMIT
LABEL org.opencontainers.image.title="Eigen Unbound" \
      org.opencontainers.image.description="Unbound DNS resolver: the recursive, DNSSEC-validating resolver the bundled Postfix uses." \
      org.opencontainers.image.url="https://github.com/eigen-is/eigen" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/eigen-is/eigen" \
      org.opencontainers.image.version="${EIGEN_VERSION}" \
      org.opencontainers.image.revision="${EIGEN_COMMIT}"

EXPOSE 53/udp 53/tcp

USER unbound

CMD ["unbound", "-d", "-c", "/etc/unbound/unbound.conf"]
