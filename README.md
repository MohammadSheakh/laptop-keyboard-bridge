# KeyBridge 0.4

KeyBridge turns a **Windows laptop keyboard** into a switchable keyboard for a **Linux PC** on the same trusted LAN.

- **Ctrl + Alt + A**: switch Laptop ↔ Linux PC.
- **Ctrl + Alt + Esc**: emergency return to the Windows laptop.
- Switching waits until all currently held keys are released to avoid stuck-key states.
- While the Linux PC is active, Windows-side keyboard input is suppressed and forwarded to Linux.

## Recommended architecture

```text
Windows laptop                         Linux PC
(native Electron sender)               (Docker receiver)
       |                                      |
       +----------- LAN / Wi-Fi --------------+
                    WebSocket :39393
```

The **Windows sender intentionally does not run in Docker**. Docker Desktop runs Linux containers behind a VM and cannot reliably provide the native Windows global keyboard hook/suppression that KeyBridge needs.

The **Linux receiver does run in Docker**. Version 0.4.1 uses a small `/dev/uinput` helper instead of X11 injection, so the Docker receiver is not tied to Electron, X11, or a logged-in graphical session.

## Automatic startup

### Linux PC: Docker receiver starts at boot

Run once from the project folder:

```bash
./scripts/setup-linux-docker.sh
```

The setup script:

1. Detects whether a working Docker daemon is available instead of assuming `docker.service` exists.
2. Enables a standard Docker Engine service at boot when that systemd unit is actually present.
3. Supports an already-running Docker Desktop/rootless daemon without forcing a nonexistent system service.
4. Loads Linux's `uinput` kernel module and configures it to load after reboot.
5. Creates a private `.env.docker` file with a random 6-digit pairing code if one does not exist.
6. Builds and starts the receiver with Docker Compose.
7. Uses `restart: unless-stopped`, so Docker brings the receiver back after reboot/daemon restart unless you intentionally stopped it.

Show receiver status:

```bash
docker compose --env-file .env.docker ps
```

Show logs:

```bash
./scripts/logs-linux-docker.sh
```

Stop/remove the receiver:

```bash
./scripts/stop-linux-docker.sh
```

Your pairing code is stored locally in `.env.docker`. That file is ignored by Git and should not be shared.

### Windows laptop: sender starts at login

Build/install the packaged Windows app:

```bash
npm install
npm run check
npm run dist:win
```

A packaged KeyBridge build registers itself with Windows to launch at **user login** and opens minimized when launched through autostart.

This is deliberately login-start rather than pre-login boot-start: the sender needs an interactive Windows user session to capture and suppress keyboard input.

Set this environment variable before launching the packaged app if you explicitly do not want autostart:

```text
KEYBRIDGE_DISABLE_AUTOSTART=1
```

## Linux Docker receiver requirements

The Linux host needs:

- Docker Engine (or another already-running compatible Docker daemon)
- Docker Compose v2 (`docker compose`)
- Linux `/dev/uinput`

### If `docker.service` does not exist

A `docker` command can be installed without the Docker Engine daemon. Version 0.4.1 detects this condition and stops with a useful message instead of trying to enable a nonexistent unit.

For supported Ubuntu/Debian hosts, install Docker Engine from Docker's official apt repository with:

```bash
./scripts/install-docker-engine.sh
```

The installer deliberately refuses to auto-remove conflicting Docker/container packages. If it reports conflicts, review them before replacing an existing container setup. After Docker Engine is installed, rerun:

```bash
./scripts/setup-linux-docker.sh
```

If you intentionally use Docker Desktop or rootless Docker, start that daemon first and verify both commands succeed:

```bash
docker info
docker compose version
```

The setup script normally prepares `uinput` automatically. You can verify it with:

```bash
ls -l /dev/uinput
```

The Compose file passes only that device into the receiver container:

```yaml
devices:
  - /dev/uinput:/dev/uinput
```

Because `/dev/uinput` can synthesize host keyboard events, treat the receiver container as a trusted local service. Do not run untrusted images with that device attached.

## Pairing

The Docker setup generates `.env.docker`, for example:

```text
KEYBRIDGE_PAIRING_CODE=483271
KEYBRIDGE_HOST_PORT=39393
```

On Windows:

1. Start KeyBridge.
2. Enter the Linux PC's LAN IP/hostname.
3. Use port `39393` unless you changed `KEYBRIDGE_HOST_PORT`.
4. Enter the pairing code from `.env.docker`.
5. Connect.
6. Press **Ctrl + Alt + A** whenever you want to move the keyboard to/from Linux.

The code becomes unavailable to other clients while a sender is paired. With a configured Docker pairing code, the same code becomes available again after the sender disconnects, which makes reboot/reconnect usage practical.

## Connection/security

KeyBridge currently uses an unencrypted WebSocket connection over the local network.

- Default receiver port: `39393`
- Only one sender can be paired at a time.
- Do **not** expose/port-forward this service to the internet.
- Use it only on a trusted/private LAN.
- If your firewall blocks it, allow TCP `39393` only from your trusted LAN.

Transport encryption/authentication stronger than the current pairing code should be added before using KeyBridge across untrusted networks.

## Development without Docker

For Electron development on the native target operating system:

```bash
npm install
npm run check
npm start
```

The original native Linux Electron receiver remains available for development, but the Docker `/dev/uinput` receiver is the recommended always-on Linux deployment.

## Docker commands

After `.env.docker` exists:

```bash
npm run docker:receiver
npm run docker:logs
npm run docker:stop
```

Equivalent Compose commands can be run directly.

## Builds

Windows installer/portable build (build on Windows):

```bash
npm run dist:win
npm run dist:portable
```

Native Linux Electron package (optional development path):

```bash
npm run dist:linux
```

## Reliability behavior

- Keystrokes are forwarded live and are not intentionally stored.
- Invalid/unsupported keycodes are rejected by the Linux Docker mapping layer.
- Common keys, extended navigation/modifier keys, numpad aliases, and F13-F24 are explicitly mapped from libuiohook keycodes to Linux evdev keycodes.
- Remote held keys are released when the connection closes or its heartbeat fails.
- Network congestion fails safe back to the Windows laptop.
- Stale WebSocket events cannot tear down a newer sender connection.
- Only one sender can control the receiver at a time.
- Docker has a TCP health check for the receiver service.

## Validation status

`npm run check` performs JavaScript syntax checks and the dependency-free test suite.

The Linux `/dev/uinput` helper is compiled with:

```text
-Wall -Wextra -Werror
```

What still requires real hardware verification:

1. Windows global capture + suppression across your actual keyboard/layout, normal/elevated apps, sleep/wake, UAC, and lock transitions.
2. Linux `/dev/uinput` behavior on your actual distribution/desktop.
3. End-to-end Docker networking and reboot recovery on your Linux PC.

The current execution environment does not expose `/dev/uinput` or a Docker daemon, so those host-level behaviors cannot be truthfully certified here without testing on your machines.
