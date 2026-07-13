#!/bin/sh
set -eu

EXT_FILE="/system/dashboard-ui/ext.js"
MODULE='extmod.push("syncplay-loader");'

if ! grep -Fq "$MODULE" "$EXT_FILE"; then
    sed -i "1a $MODULE" "$EXT_FILE"
fi
