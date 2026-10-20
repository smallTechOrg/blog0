#!/bin/bash
# blog0-vm startup script (GCE metadata `startup-script`, set by infra/provision.sh; runs as root on
# every boot). Idempotent: Docker Engine + compose plugin from Docker's apt repo (once), a 2 GB
# swapfile (e2-micro has 1 GB RAM), json-file log rotation as the Docker default, /opt/blog0.
# Marker: /var/lib/blog0/startup.done (deploy-remote.sh waits for it).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
mkdir -p /var/lib/blog0

# --- swap (2 GB) -------------------------------------------------------------------------------------
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
echo 'vm.swappiness=10' >/etc/sysctl.d/99-blog0.conf
sysctl -q -p /etc/sysctl.d/99-blog0.conf

# --- Docker Engine + compose plugin (Docker's Debian repo) -----------------------------------------------
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${codename} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Log rotation for every container (compose also sets it per service).
if [ ! -f /etc/docker/daemon.json ]; then
  mkdir -p /etc/docker
  printf '%s\n' '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }' >/etc/docker/daemon.json
  systemctl restart docker || true
fi
systemctl enable --now docker

install -d -m 0755 /opt/blog0
date -u +%Y-%m-%dT%H:%M:%SZ >/var/lib/blog0/startup.done
echo "blog0-startup: ok ($(docker --version); $(docker compose version --short))"
