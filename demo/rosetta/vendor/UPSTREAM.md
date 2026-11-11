This is an unchanged core snapshot of `packages/rosetta` from
`leanprover/verso-blueprint`, branch `feat/verso-lsp-adapter`, local commit
`bc6c4f5af69ae8c174b93a73e68a781c0e68e073`.

The commit is unpublished; the bundled source makes the demo reproducible
without a remote ref or separate checkout. The optional `verso/` Manual bridge
is excluded. Apache-2.0 licensing and upstream copyright notices are retained.

This revision replaces the earlier demo-local `Client.serverStatus` patch with
upstream's opt-in `retainedNotificationMethods` and `Client.latestNotification`.
There are no local modifications to the bundled core.

To update, replace this core from an identified upstream revision, update this
file, and rerun `npm run test:rosetta` and the demo browser suite.
`LEAN_DEMO_ROSETTA_ROOT` can select a compatible local core checkout.
