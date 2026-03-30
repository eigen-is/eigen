FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    postfix \
    opendkim \
    opendkim-tools \
    curl \
    ca-certificates \
    gettext-base \
    && rm -rf /var/lib/apt/lists/*

COPY main.cf.template /etc/postfix/main.cf.template
COPY master.cf.template /etc/postfix/master.cf.template
COPY eigen-deliver /usr/local/bin/eigen-deliver
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /usr/local/bin/eigen-deliver /entrypoint.sh

EXPOSE 25

ENTRYPOINT ["/entrypoint.sh"]
