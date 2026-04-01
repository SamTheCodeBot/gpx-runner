#!/bin/bash
cd /home/magnus/.openclaw/workspace/gpx-runner-temp
git config user.email "frank@openclaw.dev"
git config user.name "Frank"
git add -A
git commit -m "Remove Time stat and add duplicate route prevention"
git push origin main
