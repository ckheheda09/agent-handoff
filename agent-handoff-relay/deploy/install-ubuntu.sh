#!/usr/bin/env bash
set -euo pipefail
umask 077

# First installation only. Does not alter SSH, cloud firewalls, existing Caddy
# sites, system Node.js, or installed agent applications.
[[ ${EUID} -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
APP_ROOT=/opt/agent-handoff-relay
DATA_ROOT=/var/lib/agent-handoff-relay
NODE_VERSION=24.22.2
SOURCE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
for tool in curl tar xz sha256sum python3 runuser systemctl; do
    command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
[[ -f /etc/os-release ]] || { echo 'Linux distribution not detected.' >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || {
    echo 'This installer is intended for Ubuntu 24.04; review manually on other systems.' >&2; exit 1;
}
[[ ! -e "$APP_ROOT" && ! -e /etc/systemd/system/agent-handoff-relay.service && ! -e /etc/default/agent-handoff-relay && ! -e "$DATA_ROOT" ]] || {
    echo 'Existing installation found. Follow docs/DEPLOY-UBUNTU.md upgrade instructions; no files changed.' >&2; exit 1;
}
case "$(uname -m)" in x86_64) NODE_ARCH=x64 ;; aarch64|arm64) NODE_ARCH=arm64 ;; *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;; esac
WORK_ROOT=$(mktemp -d)
trap 'rm -rf -- "$WORK_ROOT"' EXIT
ARCHIVE_NAME="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
    "https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE_NAME}" --output "$WORK_ROOT/$ARCHIVE_NAME"
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
    "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" --output "$WORK_ROOT/SHASUMS256.txt"
python3 - "$WORK_ROOT" "$ARCHIVE_NAME" <<'PY'
import hashlib, pathlib, sys
root, name = pathlib.Path(sys.argv[1]), sys.argv[2]
matches = [line.split()[0] for line in (root/'SHASUMS256.txt').read_text().splitlines()
           if len(line.split()) == 2 and line.split()[1] == name]
if len(matches) != 1 or hashlib.sha256((root/name).read_bytes()).hexdigest() != matches[0]:
    raise SystemExit('Node.js archive checksum verification failed.')
PY

if ! id handoff-relay >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$DATA_ROOT" --shell /usr/sbin/nologin handoff-relay
fi
install -d -m 0755 "$APP_ROOT" "$APP_ROOT/app" "$APP_ROOT/node"
tar -xJf "$WORK_ROOT/$ARCHIVE_NAME" -C "$APP_ROOT/node" --strip-components=1
for item in src bin web deploy docs package.json README.md; do
    cp -R -- "$SOURCE_ROOT/$item" "$APP_ROOT/app/"
done
# umask 077 also applies to cp: explicitly allow the service user to read the
# application and execute Node. Credentials remain in the separate private data directory.
chown -R root:root "$APP_ROOT"
chmod -R u=rwX,go=rX "$APP_ROOT"
install -d -o handoff-relay -g handoff-relay -m 0700 "$DATA_ROOT"
install -o root -g handoff-relay -m 0640 "$SOURCE_ROOT/deploy/relay.env" /etc/default/agent-handoff-relay
install -o root -g root -m 0644 "$SOURCE_ROOT/deploy/agent-handoff-relay.service" /etc/systemd/system/agent-handoff-relay.service
runuser -u handoff-relay -- "$APP_ROOT/node/bin/node" "$APP_ROOT/app/bin/relay.mjs" init --data "$DATA_ROOT"
systemctl daemon-reload
systemctl enable --now agent-handoff-relay
echo 'Relay installed on loopback 127.0.0.1:17860. Configure Caddy/TLS separately.'
echo 'Check: curl --fail http://127.0.0.1:17860/healthz'
