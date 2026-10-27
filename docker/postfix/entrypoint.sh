#!/bin/sh
set -e

# MAIL_DOMAIN defaults to DOMAIN when not split. Used for envelope sender, virtual mailbox
# acceptance, and DKIM signing — see main.cf.template.
: "${MAIL_DOMAIN:=$DOMAIN}"
export MAIL_DOMAIN

# Trust range shared by Postfix `mynetworks` and OpenDKIM `InternalHosts`: loopback always, plus
# the docker bridge subnet so eigen-api (172.20.0.x by default) can submit and get its mail
# DKIM-signed. EIGEN_SUBNET comes from docker-compose.yml, kept in step with the `eigen` network.
# Unset → loopback only (fail closed), never the whole 172.16/12 range.
#
# The subnet's gateway is excluded: a client of a published port can arrive from it (the host
# itself, Docker Desktop, rootless Docker), and would otherwise relay. It is the gateway of the
# container's default route when that route leaves through the subnet's interface, read from
# /proc/net/route (little-endian hex), since the image has no `ip`. Otherwise, as when an override
# attaches a second network whose default route wins, the gateway is unknown, so loopback only.
# The API applies the same rule: apps/api/src/lib/auth/trusted-networks.ts.
MAIL_TRUST_NETWORKS="127.0.0.0/8"
BRIDGE_GATEWAY=""
if [ -n "${EIGEN_SUBNET:-}" ]; then
    IFS=. read -r a b c d <<EOF
${EIGEN_SUBNET%/*}
EOF
    mask=$(((0xFFFFFFFF << (32 - ${EIGEN_SUBNET#*/})) & 0xFFFFFFFF))
    subnet_hex=$(printf '%02X%02X%02X%02X' "$d" "$c" "$b" "$a")
    mask_hex=$(printf '%02X%02X%02X%02X' $((mask & 255)) $((mask >> 8 & 255)) $((mask >> 16 & 255)) $((mask >> 24)))
    gateway_hex=$(awk -v net="$subnet_hex" -v mask="$mask_hex" '
        $2 == net && $8 == mask && $3 == "00000000" { subnet_if = $1 }
        $2 == "00000000" && $8 == "00000000" && default_if == "" { default_if = $1; default_gw = $3 }
        END { if (subnet_if != "" && subnet_if == default_if) print default_gw }' /proc/net/route)
    if [ -n "$gateway_hex" ]; then
        # shellcheck disable=SC2046 # four hex bytes, split on purpose
        BRIDGE_GATEWAY=$(printf '%d.%d.%d.%d' $(echo "$gateway_hex" | sed 's/\(..\)\(..\)\(..\)\(..\)/0x\4 0x\3 0x\2 0x\1/'))
        MAIL_TRUST_NETWORKS="127.0.0.0/8 !${BRIDGE_GATEWAY} ${EIGEN_SUBNET}"
    else
        echo "WARNING: the default route does not leave through ${EIGEN_SUBNET}, so its gateway is unknown; trusting loopback only, and eigen-api cannot relay through port 25. Give the eigen network the highest gw_priority (needs Docker Engine 28 or newer)."
    fi
fi
export MAIL_TRUST_NETWORKS

echo "=== Eigen Postfix Container ==="
echo "Hostname:    ${DOMAIN}"
echo "Mail domain: ${MAIL_DOMAIN}"
echo "Trust range: ${MAIL_TRUST_NETWORKS}"

# --- Config templating ---
# Substitute $DOMAIN, $MAIL_DOMAIN and $MAIL_TRUST_NETWORKS; leave Postfix's own variables
# ($mydomain, ${recipient}) alone.
envsubst '$DOMAIN $MAIL_DOMAIN $MAIL_TRUST_NETWORKS' < /etc/postfix/main.cf.template > /etc/postfix/main.cf
envsubst '$DOMAIN $MAIL_DOMAIN' < /etc/postfix/master.cf.template > /etc/postfix/master.cf

# --- SMTP relay (optional) ---
# The keys and rules the API follows when Eigen hosts no mail: port 465 is implicit TLS, any other port
# STARTTLS, and credentials only go over TLS.
if [ -n "${SMTP_RELAY_HOST}" ]; then
    port=${SMTP_RELAY_PORT:-587}
    relay="[${SMTP_RELAY_HOST}]:${port}"
    echo "Configuring SMTP relay: ${relay}"
    postconf -e "relayhost = ${relay}"
    if [ "$port" = 465 ]; then
        postconf -e smtp_tls_wrappermode=yes smtp_tls_security_level=encrypt
    fi
    if [ -n "${SMTP_RELAY_USER}" ]; then
        echo "${relay} ${SMTP_RELAY_USER}:${SMTP_RELAY_PASSWORD}" > /etc/postfix/sasl_passwd
        postmap /etc/postfix/sasl_passwd
        chmod 600 /etc/postfix/sasl_passwd /etc/postfix/sasl_passwd.db
        postconf -e smtp_sasl_auth_enable=yes smtp_sasl_password_maps=hash:/etc/postfix/sasl_passwd \
            smtp_sasl_security_options=noanonymous smtp_tls_security_level=encrypt
    fi
fi

# --- DKIM ---
mkdir -p /data/dkim
if [ ! -f "/data/dkim/eigen.private" ]; then
    echo "Generating DKIM key for ${MAIL_DOMAIN}..."
    opendkim-genkey -b 2048 -d "${MAIL_DOMAIN}" -s eigen -D /data/dkim/
    echo ""
    echo "============================================"
    echo "=== Add this DNS TXT record for DKIM:    ==="
    echo "=== Host: eigen._domainkey.${MAIL_DOMAIN}"
    echo "=== Value, one line:"
    echo "============================================"
    # eigen.txt splits the value into quoted parts in BIND's format; a DNS panel takes it joined.
    grep -o '"[^"]*"' /data/dkim/eigen.txt | tr -d '"\n'
    echo ""
    echo "============================================"
    echo ""
fi

# OpenDKIM owns the key, and group 1000 reads it: the API, uid 1000 through data/, for the server backup. No process
# in this image runs with gid 1000. The DNS record in eigen.txt is public, for the operator to open. A key brought from
# another server may come without its eigen.txt. A data folder root may not chown, as NFS with root_squash: Postfix
# runs on, and OpenDKIM says below whether it can use the key.
{ chown -R opendkim:1000 /data/dkim && chmod 0755 /data/dkim &&
    find /data/dkim -type f -name '*.private' -exec chmod 0640 {} + &&
    find /data/dkim -type f -name '*.txt' -exec chmod 0644 {} +; } ||
    echo "WARNING: could not give the DKIM key to OpenDKIM and group 1000; the server backup may leave it out."

# Hosts whose mail OpenDKIM signs (rather than just verifying). Must include the
# docker bridge subnet — eigen-api submits SMTP from 172.20.0.x, and OpenDKIM's
# default InternalHosts is loopback only, which would silently fall back to
# verify-only and ship mail unsigned. Scoped to EIGEN_SUBNET minus its gateway (see
# MAIL_TRUST_NETWORKS above), or a forged From: of ours from outside would be signed; loopback
# only without them, never the whole 172.16/12 range. The most specific entry wins, `!` excludes.
mkdir -p /etc/opendkim
{
    echo "127.0.0.0/8"
    echo "::1"
    if [ -n "$BRIDGE_GATEWAY" ]; then
        echo "!${BRIDGE_GATEWAY}"
        echo "${EIGEN_SUBNET}"
    fi
} > /etc/opendkim/TrustedHosts

# OpenDKIM config — signs outbound mail as ${MAIL_DOMAIN} and, in verify mode (Mode sv), stamps
# inbound mail with an Authentication-Results header the API trusts for auto-processing iMIP invites.
# AuthservID fixes that header's authserv-id to our mail domain (default would be the container
# hostname); RemoveARFrom strips any pre-existing Authentication-Results claiming our authserv-id
# before delivery, so an attacker can't forge one — the header the API reads is only ever ours.
# RequireSafeKeys, on by default, takes the 0640 key because group 1000 exists in the image and has no members (the
# Dockerfile); it still refuses the key at 0644 ("can be read or written by other users").
cat > /etc/opendkim.conf <<EOF
Syslog              yes
LogWhy              yes
Mode                sv
Socket              inet:8891@127.0.0.1
Domain              ${MAIL_DOMAIN}
Selector            eigen
KeyFile             /data/dkim/eigen.private
Canonicalization    relaxed/simple
UserID              opendkim
InternalHosts       /etc/opendkim/TrustedHosts
AuthservID          ${MAIL_DOMAIN}
RemoveARFrom        ${MAIL_DOMAIN}
EOF

# --- Start services ---
echo "Starting OpenDKIM..."
if opendkim -x /etc/opendkim.conf; then
    echo "OpenDKIM started."
else
    echo "WARNING: OpenDKIM failed to start (DKIM signing disabled)."
    # Remove DKIM milter from Postfix config so it doesn't try to connect
    sed -i '/milter/d' /etc/postfix/main.cf
fi

# Queue-backlog alerting — the API can't see the queue itself, so the probe runs here.
echo "Starting queue monitor (tune with QUEUE_CHECK_INTERVAL, QUEUE_ALERT_THRESHOLD, QUEUE_ALERT_COOLDOWN)..."
/usr/local/bin/queue-monitor.sh &

# On a first boot without Caddy's certificate Dovecot makes one, and an smtpd started before it serves without TLS.
waited=0
until [ -f /certs/cert.pem ] && [ -f /certs/key.pem ]; do
    if [ "$waited" = 0 ]; then echo "Waiting for the TLS certificate in /certs..."; fi
    if [ "$waited" -ge 30 ]; then
        echo "WARNING: no TLS certificate in /certs after 30 seconds; Postfix starts without TLS."
        break
    fi
    sleep 1
    waited=$((waited + 1))
done

echo "Starting Postfix..."
exec postfix start-fg
