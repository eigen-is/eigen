FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    postfix \
    libsasl2-modules \
    opendkim \
    opendkim-tools \
    curl \
    ca-certificates \
    gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Group 1000, with no members, is the API's: it reads the DKIM key for the server backup. With this entry OpenDKIM's
# RequireSafeKeys takes the key at 0640; without it, it refuses the key with an empty reason.
RUN groupadd --gid 1000 eigen

COPY main.cf.template /etc/postfix/main.cf.template
COPY master.cf.template /etc/postfix/master.cf.template
COPY sender_login.regexp /etc/postfix/sender_login.regexp
COPY null_sender.regexp /etc/postfix/null_sender.regexp
COPY eigen-deliver /usr/local/bin/eigen-deliver
COPY queue-monitor.sh /usr/local/bin/queue-monitor.sh
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /usr/local/bin/eigen-deliver /usr/local/bin/queue-monitor.sh /entrypoint.sh

ARG EIGEN_VERSION
ARG EIGEN_COMMIT
LABEL org.opencontainers.image.title="Eigen Postfix" \
      org.opencontainers.image.description="Postfix SMTP relay that delivers Eigen mail in and out." \
      org.opencontainers.image.url="https://github.com/eigen-is/eigen" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/eigen-is/eigen" \
      org.opencontainers.image.version="${EIGEN_VERSION}" \
      org.opencontainers.image.revision="${EIGEN_COMMIT}"

EXPOSE 25 465 587

ENTRYPOINT ["/entrypoint.sh"]
