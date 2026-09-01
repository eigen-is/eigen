# Fail2ban for the bundled mail containers (opt-in)

Bans IP addresses that flood Eigen's mail ports with failed logins — Postfix's submission ports and Dovecot's IMAPS. It is the outermost layer of the login-flood defence, after the API's per-IP failure limiter and Postfix's anvil rate limits, and the only one that stops the traffic before it reaches the container.

This ships as host config, not as a container. Fail2ban writes host firewall rules, and reading the container log through the journald driver would break the dev stack on Docker Desktop, so wiring it into `docker-compose.yml` would cost every local setup something to help one production host.

## Install

On Debian or Ubuntu with an iptables firewall:

```bash
apt-get install fail2ban
cp /opt/eigen/docker/fail2ban/filter.d/eigen-postfix-sasl.conf  /etc/fail2ban/filter.d/
cp /opt/eigen/docker/fail2ban/filter.d/eigen-dovecot-auth.conf  /etc/fail2ban/filter.d/
cp /opt/eigen/docker/fail2ban/jail.d/eigen-mail-sasl.conf       /etc/fail2ban/jail.d/
systemctl enable --now fail2ban
systemctl restart fail2ban
```

## Reload after every eigen update

Fail2ban expands the jail's log glob only when the jail starts. The Docker json-log path embeds the container ID, so any `docker compose up` that recreates the postfix or dovecot container leaves both jails polling deleted log files — `fail2ban-client status` still reports them up, but nothing matches and nobody gets banned. After every update:

```bash
fail2ban-client reload
```

On a host that updates unattended, put the reload in a daily cron so a forgotten one can't disarm the jails for long.

## Check it works

```bash
# the jails are loaded and counting
fail2ban-client status eigen-postfix-sasl
fail2ban-client status eigen-dovecot-auth

# the filters match your log lines (>0 matches after an abuse run)
fail2ban-regex /var/lib/docker/containers/*/*-json.log /etc/fail2ban/filter.d/eigen-postfix-sasl.conf
fail2ban-regex /var/lib/docker/containers/*/*-json.log /etc/fail2ban/filter.d/eigen-dovecot-auth.conf

# unban an address
fail2ban-client set eigen-postfix-sasl unbanip 203.0.113.9
```

## Tuning

- `maxretry = 5` and `findtime = 10m`: five failed logins from one address within ten minutes. A client with a stale password retries a few times; a botnet does thousands.
- `bantime = 1h` with `bantime.increment = true`, up to `bantime.maxtime = 2d` for repeat offenders.
- Add `ignoreip = <your CIDR>` to a jail if you administer the server from a fixed address and would rather not risk locking yourself out.
- `chain = DOCKER-USER` in the ban action is required. Docker DNATs published ports before the `INPUT` chain, so a ban in `INPUT` never sees the packets. On an nftables-only host use `banaction = nftables-allports` and check that the ban lands ahead of Docker's rules.
- Each jail counts on its own, so a botnet that sprays submission and IMAP is five failures away from a ban on either side.

## Files

- `filter.d/eigen-postfix-sasl.conf` matches Postfix's `warning: <host>[<ip>]: SASL LOGIN authentication failed` lines inside the Docker json-file log, where `<host>` is the client's rDNS name or `unknown` when it has none. It exists because the json wrapper breaks the syslog line anchor and the date position the distro's postfix filter expects; the failure pattern itself is the distro's.
- `filter.d/eigen-dovecot-auth.conf` matches the failed-IMAP-login lines Dovecot writes to stderr: the login process's `Aborted login (auth failed, ...) ... rip=<ip>` and the auth process's `checkpassword(<user>,<ip>) ... Login failed`. Postfix's log covers submission only, and Dovecot serves IMAPS on :993 itself.
- `jail.d/eigen-mail-sasl.conf` holds both jails: log glob, thresholds, and the DOCKER-USER ban action.
