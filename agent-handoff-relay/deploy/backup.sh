#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ ${EUID} -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
BACKUP_ROOT=/var/backups/agent-handoff-relay
DATA_ROOT=/var/lib/agent-handoff-relay
install -d -m 0700 "$BACKUP_ROOT"
BACKUP_FILE="$BACKUP_ROOT/relay-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
[[ ! -e "$BACKUP_FILE" ]] || { echo 'Backup path exists; retry later.' >&2; exit 1; }
WAS_ACTIVE=false
if systemctl is-active --quiet agent-handoff-relay; then WAS_ACTIVE=true; systemctl stop agent-handoff-relay; fi
restart_if_needed() { if [[ "$WAS_ACTIVE" == true ]]; then systemctl start agent-handoff-relay; fi; }
trap restart_if_needed EXIT
tar --exclude='./server.lock' -czf "$BACKUP_FILE" -C "$DATA_ROOT" .
sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"
echo "$BACKUP_FILE"
echo 'Copy this backup and checksum to a different device; this script does not do off-site transfer.'
