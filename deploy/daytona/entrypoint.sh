#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/outreach
exec node deploy/daytona/launcher.mjs
