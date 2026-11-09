import { spawn } from "node:child_process";
import { prepareRosetta } from "../demo/server/rosetta.mjs";

const binary = await prepareRosetta();
const child = spawn(process.execPath, ["--test", "test/rosetta-host.mjs"], {
  stdio: "inherit", env: { ...process.env, LEAN_DEMO_ROSETTA_BINARY: binary },
});
child.once("error", error => { console.error(error); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
