// Stand-in for a coding agent CLI in AgentRunner tests. Its script comes from the environment:
// FAKE_AGENT_LINES (JSON array of stdout lines), FAKE_AGENT_STDERR, FAKE_AGENT_EXIT, FAKE_AGENT_PAD (the number of
// x's that replace %PAD% in both), FAKE_AGENT_CHILD_HEARTBEAT (a file a child process keeps appending to).
import { spawn } from 'node:child_process';

const pad = 'x'.repeat(Number(process.env.FAKE_AGENT_PAD ?? 0));
const fill = (text) => text.replaceAll('%PAD%', pad);

const heartbeat = process.env.FAKE_AGENT_CHILD_HEARTBEAT;
if (heartbeat) {
  // Like an agent's MCP server or shell: it lives until something kills it. The pid goes first so the test can check it.
  const beat = 'const fs = require("node:fs"); const f = process.argv[1]; fs.writeFileSync(f, `${process.pid}\\n`);'
    + ' setInterval(() => fs.appendFileSync(f, "."), 50);';
  // Detached on Windows only: Node's job object would end an attached child with this process, which an agent written
  // in another language doesn't do. Elsewhere it has to stay in this process group.
  spawn(process.execPath, ['-e', beat, heartbeat], {
    stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32',
  });
  setInterval(() => undefined, 1000);
}

if (process.env.FAKE_AGENT_STDERR) process.stderr.write(fill(process.env.FAKE_AGENT_STDERR));
for (const line of JSON.parse(process.env.FAKE_AGENT_LINES ?? '[]')) process.stdout.write(`${fill(line)}\n`);
process.exitCode = Number(process.env.FAKE_AGENT_EXIT ?? 0);
