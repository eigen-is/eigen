# Fail2ban for the bundled Postfix (opt-in)

Bans IP addresses that flood Eigen's mail ports with failed SASL logins. It is the outermost layer of the SASL-flood defence, after the API's per-IP failure limiter and Postfix's anvil rate limits, and the only one that stops the traffic before it reaches the container.

This ships as host config, not as a container. Fail2ban writes host firewall rules, and reading the container log through the journald driver would break the dev stack on Docker Desktop, so wiring it into `docker-compose.yml` would cost every local setup something to help one production host.

## Install

On Debian or Ubuntu with an iptables firewall:

```bash
apt-get install fail2ban
cp /opt/eigen/docker/fail2ban/filter.d/eigen-postfix-sasl.conf /etc/fail2ban/filter.d/
cp /opt/eigen/docker/fail2ban/jail.d/eigen-postfix-sasl.conf   /etc/fail2ban/jail.d/
systemctl enable --now fail2ban
systemctl restart fail2ban
```

## Check it works

```bash
# the jail is loaded and counting
fail2ban-client status eigen-postfix-sasl

# the filter matches your postfix lines (>0 matches after an abuse run)
fail2ban-regex /var/lib/docker/containers/*/*-json.log /etc/fail2ban/filter.d/eigen-postfix-sasl.conf

# unban an address
fail2ban-client set eigen-postfix-sasl unbanip 203.0.113.9
```

## Tuning

- `maxretry = 5` and `findtime = 10m`: five failed logins from one address within ten minutes. A client with a stale password retries a few times; a botnet does thousands.
- `bantime = 1h` with `bantime.increment = true`, up to `bantime.maxtime = 2d` for repeat offenders.
- Add `ignoreip = <your CIDR>` to the jail if you administer the server from a fixed address and would rather not risk locking yourself out.
- `chain = DOCKER-USER` in the ban action is required. Docker DNATs published ports before the `INPUT` chain, so a ban in `INPUT` never sees the packets. On an nftables-only host use `banaction = nftables-allports` and check that the ban lands ahead of Docker's rules.

## Files

- `filter.d/eigen-postfix-sasl.conf` matches Postfix's `warning: unknown[<ip>]: SASL LOGIN authentication failed` lines inside the Docker json-file log. The distro's `postfix-sasl` filter misses them, because these lines carry no `client=` field.
- `jail.d/eigen-postfix-sasl.conf` is the jail: log glob, thresholds, and the DOCKER-USER ban action.
