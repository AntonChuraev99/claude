#!/usr/bin/env bash
# Compatibility shim.
#
# The status line is rendered by statusline.py, which settings.json invokes
# directly — a shell wrapper costs more than the render itself on Windows.
# This file stays so that sessions started before that settings change (Claude
# Code reads statusLine at startup) keep working until they are restarted.

exec python "$(dirname "$0")/statusline.py"
