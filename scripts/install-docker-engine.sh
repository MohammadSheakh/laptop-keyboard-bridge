#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  SUDO=()
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo is required to install Docker Engine." >&2
    exit 1
  fi
  SUDO=(sudo)
fi

if [[ ! -r /etc/os-release ]]; then
  echo "Cannot detect Linux distribution (/etc/os-release missing)." >&2
  exit 1
fi

# shellcheck disable=SC1091
. /etc/os-release

case "${ID:-}" in
  ubuntu)
    repo_os="ubuntu"
    suite="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
    ;;
  debian)
    repo_os="debian"
    suite="${VERSION_CODENAME:-}"
    ;;
  *)
    cat >&2 <<MSG
This installer supports official Ubuntu and Debian Docker Engine packages only.
Detected distribution: ${PRETTY_NAME:-${ID:-unknown}}

Install Docker Engine + Compose v2 using Docker's instructions for your distro,
then rerun:
  ./scripts/setup-linux-docker.sh
MSG
    exit 1
    ;;
esac

if [[ -z "$suite" ]]; then
  echo "Could not determine the distribution codename for Docker's apt repository." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get is required by this installer." >&2
  exit 1
fi

# Avoid silently replacing an already-working Docker installation.
if command -v docker >/dev/null 2>&1 && (docker info >/dev/null 2>&1 || "${SUDO[@]}" docker info >/dev/null 2>&1); then
  echo "A working Docker daemon is already available; no installation needed."
  exit 0
fi

echo "Installing Docker Engine from Docker's official ${repo_os} repository..."
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y ca-certificates curl
"${SUDO[@]}" install -m 0755 -d /etc/apt/keyrings
"${SUDO[@]}" curl -fsSL "https://download.docker.com/linux/${repo_os}/gpg" -o /etc/apt/keyrings/docker.asc
"${SUDO[@]}" chmod a+r /etc/apt/keyrings/docker.asc

arch="$(dpkg --print-architecture)"
"${SUDO[@]}" tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF2
Types: deb
URIs: https://download.docker.com/linux/${repo_os}
Suites: ${suite}
Components: stable
Architectures: ${arch}
Signed-By: /etc/apt/keyrings/docker.asc
EOF2

"${SUDO[@]}" apt-get update

# Stop rather than auto-remove if known conflicting distro packages are present.
conflicts=()
for pkg in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
  if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q '^install ok installed$'; then
    conflicts+=("$pkg")
  fi
done

if ((${#conflicts[@]} > 0)); then
  printf 'Conflicting Docker/container packages are installed: %s\n' "${conflicts[*]}" >&2
  cat >&2 <<'MSG'
For safety, this script will not remove existing packages automatically.
Docker's official documentation requires conflicting packages to be removed
before installing Docker CE. Review them, then remove the ones you intend to
replace and rerun this script.
MSG
  exit 1
fi

"${SUDO[@]}" apt-get install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

if command -v systemctl >/dev/null 2>&1 && systemctl cat docker.service >/dev/null 2>&1; then
  "${SUDO[@]}" systemctl enable --now docker.service
  if systemctl cat containerd.service >/dev/null 2>&1; then
    "${SUDO[@]}" systemctl enable --now containerd.service
  fi
fi

echo
echo "Docker Engine installation complete."
"${SUDO[@]}" docker version
"${SUDO[@]}" docker compose version

echo
echo "Now run:"
echo "  ./scripts/setup-linux-docker.sh"
