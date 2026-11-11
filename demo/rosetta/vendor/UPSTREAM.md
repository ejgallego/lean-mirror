This is a snapshot of the Rosetta core package from
leanprover/verso-blueprint, packages/rosetta, branch feat/verso-lsp-adapter,
commit c25e9a9995c35f685e16277d411f1c93802889fc.

It is vendored for this experimental demo while Rosetta is unpublished.
The separate VersoRosetta Manual bridge is excluded. Rosetta's Apache-2.0
license and upstream copyright notices are retained. To update, replace this
core package from an identified upstream revision and rerun test:rosetta and
the demo browser suite. LEAN_DEMO_ROSETTA_ROOT can select a local checkout.

Local patch: `Rosetta/Client.lean` retains the latest experimental/serverStatus
separately from the bounded notification journal, exposed by `Client.serverStatus`.
The demo uses it to distinguish workspace loading from valid empty analysis.
The matching mock-server/spike regression verifies status after journal overflow.
