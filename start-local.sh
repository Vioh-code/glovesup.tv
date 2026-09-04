#!/bin/bash
set -e

echo "Starting GlovesUp (local)..."
export NODE_ENV=development

node --watch index.js
