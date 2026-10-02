---
title: "Run Eigen behind your own web server"
description: "Let nginx, Apache, Caddy, Traefik, or a tunnel handle HTTPS and forward to Eigen, with the settings live editing and sign-in limits need."
type: how-to
category: Install
tags: [self-hosting, install, nginx, apache, caddy, traefik, proxy, https, tunnel]
related: [self-hosting/install, self-hosting/troubleshooting]
order: 35
updated: 2026-09-30
---

If your server already runs a web server for other sites, it keeps ports 80 and 443, and it forwards Eigen's traffic to Eigen. The same goes for a tunnel like Cloudflare Tunnel, when you don't want public ports at all. This page shows how to set that up for each web server.

## Choose it at setup

When `./eigen setup` asks **How do people reach Eigen over HTTPS?**, pick **My web server forwards to Eigen**. Then give the address Eigen should listen on for your web server, `127.0.0.1:8080` by default. That address is only reachable from the machine itself.

Setup then writes a ready-made configuration for three web servers into the install folder, filled in with your web address:

- `eigen.nginx.conf`: link it into `/etc/nginx/sites-enabled/` and reload nginx.
- `eigen.apache.conf`: copy it to `/etc/apache2/sites-available/eigen.conf`, run `a2ensite eigen`, and reload Apache.
- `eigen.Caddyfile`: import it in your `Caddyfile` and reload Caddy.

The nginx and Apache files expect a certbot certificate for your web address. Caddy gets its own.

## What the web server must do

The files setup writes do four things. A web server you set up by hand, or another one, must do the same:

- **Forward everything** for your web address to the address Eigen listens on, with the original host name.
- **Keep live connections open and unbuffered.** Live editing in Docs, Sheets, Slides, and Stickies keeps a connection open for as long as the document is. Live updates arrive in small pieces, which a buffering web server holds back.
- **Set `X-Real-IP` to the visitor's address.** Eigen limits sign-in attempts and codes per visitor by that header. Without it, every visitor shares one limit, and one person guessing passwords locks everyone out. Eigen does not trust `X-Forwarded-For` for this, because a visitor can add their own value to it.
- **Let large uploads through.** A file you upload arrives in one request, and a backup you upload in Admin can be up to 1 GB. nginx refuses a request over 1 MB unless you raise its limit, as `eigen.nginx.conf` does.

### Apache

The top of `eigen.apache.conf` lists the modules to turn on (`a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers`). It also has the commands to switch from the `mpm_prefork` module to `mpm_event`. Prefork uses one process for every open connection, and Eigen's live connections use up its slots fast.

## When your web server runs in Docker

Inside Docker, `127.0.0.1` is the web server's own address, not your machine's, so the ready-made files cannot reach Eigen. Two ways to fix that:

- **Join Eigen's Docker network** (the better one). Eigen's network is `<project>_eigen`, which is `eigen_eigen` for an install in `/opt/eigen`. Attach your web server to it, and forward to `eigen-static:8080`. Nothing extra is open, and the traffic stays inside Docker. For example, in the Compose file of your web server:

  ```yaml
  services:
    nginx-proxy-manager:
      networks: [default, eigen]
  networks:
    eigen:
      external: true
      name: eigen_eigen
  ```

- **Listen on Docker's own address.** Answer `172.17.0.1:8080` when setup asks where Eigen should listen. Your web server in Docker can reach that address, other machines on your network cannot.

**Nginx Proxy Manager:** in the edit dialog of the proxy host, switch on **Websockets Support**. It is off by default, and without it live editing fails to connect without saying so.

## Traefik

Setup writes no Traefik file, but Traefik can find Eigen by itself through Docker labels. Put these in `docker-compose.override.yml` in the install folder, which `./eigen` reads on every command and an update leaves alone:

```yaml
services:
  eigen-static:
    networks: [eigen, traefik]
    labels:
      traefik.enable: "true"
      traefik.docker.network: traefik
      traefik.http.routers.eigen.rule: Host(`eigen.example.com`)
      traefik.http.routers.eigen.entrypoints: websecure
      traefik.http.routers.eigen.tls.certresolver: letsencrypt
      traefik.http.services.eigen.loadbalancer.server.port: "8080"
networks:
  traefik:
    external: true
```

Replace `eigen.example.com` with your web address. `traefik` (the Docker network Traefik is on), `websecure` (its HTTPS entry point) and `letsencrypt` (its certificate resolver) are common names: use the ones from your own Traefik setup. Then run `./eigen restart`.

Traefik runs outside Docker? Add Eigen to its file configuration instead:

```yaml
http:
  routers:
    eigen:
      rule: Host(`eigen.example.com`)
      entryPoints: [websecure]
      tls:
        certResolver: letsencrypt
      service: eigen
  services:
    eigen:
      loadBalancer:
        servers:
          - url: http://127.0.0.1:8080
```

Traefik keeps connections open and sets `X-Real-IP` to the visitor's address by itself, so this is all Eigen needs. One setting of Traefik's own is worth changing: it stops reading a request after 60 seconds, which cuts off a large upload on a slow line. Turn that limit off for the entry point Eigen uses, in Traefik's own configuration, like `--entrypoints.websecure.transport.respondingTimeouts.readTimeout=0`.

<div class="eigen-callout">

Eigen's own test setup runs the nginx, Apache, and Caddy files against a real install. This Traefik recipe has not been through that test. If something in it does not work for you, please report it.

</div>

## Cloudflare Tunnel or Tailscale Funnel

A tunnel means no public ports on your machine at all. Pick **My web server forwards to Eigen** and keep `127.0.0.1:8080`. The tunnel then forwards to that address, live connections included.

**Cloudflare Tunnel**, in the `config.yml` of `cloudflared`:

```yaml
ingress:
  - hostname: eigen.example.com
    service: http://localhost:8080
  - service: http_status:404
```

**Tailscale Funnel:**

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale funnel --bg 443
```

Neither tunnel sets `X-Real-IP`, so all visitors share one sign-in limit. If that matters to you, put nginx, Apache, or Caddy between the tunnel and Eigen.

## Mail certificates without Eigen's own web server

Hosting mail behind your own web server? The mail server still needs a certificate for IMAP and for sending, and without Eigen's own web server nothing gets one for it. It reads `data/certs/cert.pem` and `data/certs/key.pem`, and makes a self-signed one when they are missing. Mail apps connect to your web address, so copy the Let's Encrypt certificate for that name there, with a certbot hook that runs after every renewal:

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/eigen.sh > /dev/null <<'EOF'
#!/bin/sh
set -e
live=/etc/letsencrypt/live/eigen.example.com
certs=/opt/eigen/data/certs
cp "$live/privkey.pem" "$certs/key.pem.tmp" && chmod 600 "$certs/key.pem.tmp" && mv -f "$certs/key.pem.tmp" "$certs/key.pem"
cp "$live/fullchain.pem" "$certs/cert.pem.tmp" && chmod 644 "$certs/cert.pem.tmp" && mv -f "$certs/cert.pem.tmp" "$certs/cert.pem"
cd /opt/eigen && docker compose --env-file .env.production kill -s HUP postfix dovecot
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/eigen.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/eigen.sh
```

Replace `eigen.example.com` with your web address. The last line runs the hook once, to put the current certificate in place. The mail server reloads it straight away.
