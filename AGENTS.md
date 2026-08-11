# Ignifire release policy

- Treat `testing` as the default branch for every future code change, commit, build, and push.
- A routine request to "build", "package", "publish", "push", or "release" remains on `testing` unless the user explicitly requests a branch promotion in the current conversation.
- Promote `testing` to `beta` only when the user explicitly asks. A beta promotion may trigger the public beta updater manifest, GitHub prerelease, and web-player synchronization.
- Promote `beta` to `main` only when the user explicitly asks. Do not infer stable-promotion permission from an earlier promotion.
- Do not merge, push, tag, or publish from `beta` or `main` outside the promotion explicitly authorized by the user.
- `testing` must not publish a public updater release by default. Keep its updater manifest marked as `testing` with no downloadable release URL.
- Keep `updates/latest.json` aligned with its branch: `testing` is unpublished, `beta` is a GitHub prerelease, and `main` is stable.
