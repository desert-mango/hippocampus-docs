#!/bin/bash
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 28 August 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Serve the static documentation site locally for browser preview.
# Local preview — THE documented serve command.
# GitHub Pages serves the same files byte-identical; nothing to build.
cd "$(dirname "$0")/.." && exec python3 -m http.server "${1:-8130}"
