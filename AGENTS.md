# Ignifire release policy

- Treat `testing` as the default branch for every future code change, commit, build, and push.
- A routine request to "build", "package", "publish", "push", or "release" remains on `testing` unless the user explicitly requests a branch promotion in the current conversation.
- Promote `testing` to `beta` only when the user explicitly asks. A beta promotion may trigger the public beta updater manifest, GitHub prerelease, and web-player synchronization.
- Promote `beta` to `main` only when the user explicitly asks. Do not infer stable-promotion permission from an earlier promotion.
- Do not merge, push, tag, or publish from `beta` or `main` outside the promotion explicitly authorized by the user.
- Testing commits may publish a `testing-v*` GitHub prerelease and testing updater manifest, but the desktop app must offer that channel only to server-validated authorized accounts.
- Keep `updates/latest.json` aligned with its branch: `testing` and `beta` are GitHub prereleases, while `main` is stable.
