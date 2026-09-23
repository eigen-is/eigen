FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    dovecot-imapd \
    bash \
    curl \
    jq \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY dovecot.conf /etc/dovecot/dovecot.conf
COPY eigen-checkpassword /usr/local/bin/eigen-checkpassword
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /usr/local/bin/eigen-checkpassword /entrypoint.sh

# Create vmail user with UID 1000 to match API container
RUN groupadd -g 1000 vmail && useradd -u 1000 -g 1000 -d /data/home -s /usr/sbin/nologin vmail

ARG EIGEN_VERSION
ARG EIGEN_COMMIT
LABEL org.opencontainers.image.title="eigen-dovecot" \
      org.opencontainers.image.description="Dovecot IMAP server for Eigen mailboxes." \
      org.opencontainers.image.url="https://github.com/eigen-is/eigen" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/eigen-is/eigen" \
      org.opencontainers.image.version="${EIGEN_VERSION}" \
      org.opencontainers.image.revision="${EIGEN_COMMIT}"

EXPOSE 993

ENTRYPOINT ["/entrypoint.sh"]
