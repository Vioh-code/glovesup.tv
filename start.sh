#!/bin/bash
set -e

echo "Starting GlovesUp (live)..."
export NODE_ENV=production

npm install
node index.js
