Maintainer note (moved off the public Agent tools list, 2026-10-21)

# Media uploads — a gap, documented honestly

There is **no Cloudinary MCP today**. The closest existing piece is a private
`cloudinary-upload` agent skill (upload a local image or video, get back a CDN URL) that
lives in Kyle's agent configuration, not in a lab-shareable repository.

## What exists

- The `cloudinary-upload` skill: works for the agent it is installed for; not packaged,
  not documented for others, credentials handled per-machine.

## What a lab tool should be (when someone builds it)

- An MCP server with one obvious tool: `upload(file) → URL`, plus list/delete.
- Credentials from the OS keychain, never from a committed config.
- A public repository with the same bar as the other tools here: from-scratch setup,
  placeholder-only examples, secrets scanned before every release.

Until then: if you need media hosting for a lab page, ask in the lab chat — do not
hand-copy someone else's credentials.
