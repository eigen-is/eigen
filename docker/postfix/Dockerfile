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

COPY main.cf.template /etc/postfix/main.cf.template
COPY master.cf.template /etc/postfix/master.cf.template
COPY sender_login.regexp /etc/postfix/sender_login.regexp
COPY null_sender.regexp /etc/postfix/null_sender.regexp
COPY eigen-deliver /usr/local/bin/eigen-deliver
COPY queue-monitor.sh /usr/local/bin/queue-monitor.sh
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /usr/local/bin/eigen-deliver /usr/local/bin/queue-monitor.sh /entrypoint.sh

EXPOSE 25 465 587

ENTRYPOINT ["/entrypoint.sh"]
