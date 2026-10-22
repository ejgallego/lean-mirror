# Workspace save and recovery contract

The local demo's `/lean-document` endpoint registers only Main.lean and
Helper.lean. The public editor library does not own filesystem writes. The host
keeps dirty text and disk revision hashes; edits made while a save is pending
remain dirty. Multi-file saves are independent, not a filesystem transaction.

## Writers and publication

Reads and saves through one store run in a per-URI queue. Separate backend
instances coordinate save ownership through an exclusive lock directory beside
the source, under `.lean-mirror-recovery/<filename>.lock`. Contention and stale
revision hashes return HTTP 409 without discarding the browser's dirty buffer.

The host writes and syncs a proposal, explicitly restores the source's permission
bits, and records a recovery journal. It then renames the actual source inode to
a unique `.previous` archive, checks its hash, and publishes the proposal with an
exclusive hardlink. If another writer has recreated the destination, publication
fails instead of replacing that file. On failure the old inode is restored when
the destination is absent. Existing destinations are kept.

An outside writer with an already-open file descriptor can still change the
retained inode. Its writes remain recoverable in the archive even if publication
succeeds. A successful response therefore does not prove that every outside
writer observed the same revision. This is recoverable publication, not atomic
compare-and-swap against arbitrary editors. The source path can briefly be absent
for external readers during the handoff; API reads through the same store wait.
The filesystem must support same-directory renames and hardlinks. ACLs, ownership,
and special permission bits are outside this sample's preservation contract.

## Recovery material

Successful responses include `recoveryPath`. Prior disk inodes are retained as
`.lean-mirror-recovery/<filename>.<uuid>.previous`; they are not automatically
deleted because they may contain concurrent external edits. This local history
uses disk space until inspected and removed by the workspace owner. The recovery
directory is excluded from Git and is never writable through the HTTP endpoint.

If the backend stops during a save, a lock and `journal.json` may remain. New
saves report a conflict and identify the lock; the backend never guesses that a
recorded PID is safe to steal. To recover:

1. Stop all backend instances and other writers for that source. Copy the current
   source, dirty browser text, and the entire recovery directory somewhere safe.
2. Read the journal's `path`, `backup`, and `temporary` fields. Compare all existing
   versions. If the source is absent, restore the chosen version without replacing
   another writer's newly created destination.
3. Once the source and recovery copies are verified, remove only that completed
   transaction's temporary file, journal, and lock directory. Retain any archive
   that contains work you still need. Restart the backend and reload the disk
   version after copying unsaved browser edits.

The proposal's contents are synced before publication. Journals and directory
mutations are not fsynced, so this procedure covers process interruption, not a
power-loss durability guarantee. An abrupt machine/filesystem failure may require
filesystem-specific recovery.

## HTTP behavior and verification

GET returns `{uri, text, revision}`. POST accepts the same shape and returns the
new revision plus its recovery path. Invalid payloads return 400, oversized
bodies 413, unregistered or non-regular files 403, conflicts 409, and unsupported
methods 405. Origin checks and body limits still apply at the backend boundary.

`test/lean-documents.test.ts` covers same-store ordering, separate-store ownership,
an outside write during proposal creation, stale revisions, empty saves, strict
umask, and interrupted journals. `test/lean-document-http.test.ts` exercises the
status contract over real sockets. Source and packed workspace browser scenarios
exercise dirty buffers, saves, conflicts, and reconnection.
