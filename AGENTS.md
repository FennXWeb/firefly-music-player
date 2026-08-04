# Firefly release policy

- Treat `beta` as the default branch for every future app build, updater manifest, tag, push, and GitHub prerelease.
- Do not push, merge, tag, publish, or create a GitHub Release from `main` unless the user explicitly authorizes a stable release in the current conversation.
- A request to "build", "package", "publish", "push", or "release" without the word "stable" means beta only.
- Stable releases require a fresh, explicit instruction from the user. Do not infer permission from an earlier stable release.
- Keep `updates/latest.json` on each branch aligned with that branch's channel. Beta releases must remain marked as GitHub prereleases.
