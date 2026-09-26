#!/bin/sh
# Bundle the scene engine (src/) into one minified script that exposes window.SakuraRiver.
set -e
cd "$(dirname "$0")/.."
npx esbuild src/main.js --bundle --format=iife --minify --target=es2020 --outfile=dist/sakura.js --log-level=warning
echo "built dist/sakura.js"
