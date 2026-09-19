#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env.docker"

cd "$PROJECT_DIR"

have_system_unit() {
  local unit="$1"
  command -v systemctl >/dev/null 2>&1 && systemctl cat "$unit" >/dev/null 2>&1
}

have_user_unit() {
  local unit="$1"
  command -v systemctl >/dev/null 2>&1 && systemctl --user cat "$unit" >/dev/null 2>&1
}

docker_direct_works() {
  docker info >/dev/null 2>&1
}

docker_sudo_works() {
  command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1
}

if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<MSG
Docker CLI is not installed.

On Ubuntu/Debian, install Docker Engine with:
  ./scripts/install-docker-engine.sh

Then run this setup script again.
MSG
  exit 1
fi

# Do not assume that the presence of the Docker CLI means a system Docker
# daemon/service exists. Docker Desktop, rootless Docker, and CLI-only installs
# are all possible.
if ! docker_direct_works && ! docker_sudo_works; then
  if have_system_unit docker.service; then
    echo "Starting and enabling the system Docker Engine..."
    sudo systemctl enable --now docker.service
    if have_system_unit containerd.service; then
      sudo systemctl enable --now containerd.service
    fi
  elif have_user_unit docker.service; then
    echo "Starting the rootless user Docker Engine..."
    systemctl --user enable --now docker.service
    if command -v loginctl >/dev/null 2>&1; then
      echo "Enabling user-service persistence across reboot..."
      sudo loginctl enable-linger "$USER"
    fi
  else
    cat >&2 <<'MSG'
Docker CLI was found, but no working Docker daemon or docker.service was found.
This usually means Docker Engine is not installed (CLI-only installation), or
Docker Desktop/rootless Docker is installed but not running.

On Ubuntu/Debian, the supported fix for this project is:
  ./scripts/install-docker-engine.sh

If you intentionally use Docker Desktop, start Docker Desktop and verify:
  docker info
  docker compose version

Then run this setup script again.
MSG
    exit 1
  fi
fi

# Choose whether Docker commands need sudo.
if docker_direct_works; then
  DOCKER=(docker)
elif docker_sudo_works; then
  echo "Current user cannot access the Docker daemon directly; using sudo for Docker commands."
  DOCKER=(sudo docker)
else
  echo "Docker daemon is still unavailable after startup attempt." >&2
  exit 1
fi

if ! "${DOCKER[@]}" compose version >/dev/null 2>&1; then
  cat >&2 <<MSG
Docker Compose v2 is required (the 'docker compose' command).

On Ubuntu/Debian with Docker's official repository:
  sudo apt update
  sudo apt install docker-compose-plugin
MSG
  exit 1
fi

# For standard system Docker, make boot behavior explicit. Debian/Ubuntu often
# enable these automatically, but this is harmless when the units exist.
if have_system_unit docker.service; then
  echo "Ensuring Docker starts automatically at boot..."
  sudo systemctl enable docker.service >/dev/null
  if have_system_unit containerd.service; then
    sudo systemctl enable containerd.service >/dev/null
  fi
fi

echo "Loading the Linux uinput kernel module..."
sudo modprobe uinput
printf '%s\n' 'uinput' | sudo tee /etc/modules-load.d/keybridge-uinput.conf >/dev/null

if [[ ! -e /dev/uinput ]]; then
  echo "/dev/uinput is still unavailable after loading the uinput module." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  raw="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
  code=$((100000 + raw % 900000))
  cat > "$ENV_FILE" <<ENV
KEYBRIDGE_PAIRING_CODE=$code
KEYBRIDGE_HOST_PORT=39393
ENV
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE with a random pairing code."
else
  chmod 600 "$ENV_FILE"
fi

pairing_code="$(sed -n 's/^KEYBRIDGE_PAIRING_CODE=//p' "$ENV_FILE" | tail -n 1)"
host_port="$(sed -n 's/^KEYBRIDGE_HOST_PORT=//p' "$ENV_FILE" | tail -n 1)"

if [[ ! "$pairing_code" =~ ^[0-9]{6}$ ]]; then
  echo "KEYBRIDGE_PAIRING_CODE in .env.docker must be exactly 6 digits." >&2
  exit 1
fi

if [[ ! "$host_port" =~ ^[0-9]+$ ]] || (( host_port < 1 || host_port > 65535 )); then
  echo "KEYBRIDGE_HOST_PORT in .env.docker must be an integer from 1 to 65535." >&2
  exit 1
fi

echo "Building and starting the KeyBridge Linux receiver..."
"${DOCKER[@]}" compose --env-file "$ENV_FILE" up -d --build

echo
echo "KeyBridge receiver is running."
echo "Pairing code: $pairing_code"
echo "Receiver port: $host_port"
echo "It will restart automatically when Docker/this PC restarts unless you manually stop it."
echo
echo "Status:"
"${DOCKER[@]}" compose --env-file "$ENV_FILE" ps
