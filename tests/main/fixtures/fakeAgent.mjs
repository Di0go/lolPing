// Stand-in for a coding agent CLI in AgentRunner tests. Its script comes from the environment:
// FAKE_AGENT_LINES (JSON array of stdout lines), FAKE_AGENT_STDERR, FAKE_AGENT_EXIT, FAKE_AGENT_PAD (the number of
// x's that replace %PAD% in both), FAKE_AGENT_CHILD_HEARTBEAT (a file a child process keeps appending to).
// Given `--answer-over-mcp <file>` (Claude's mcpServers file), it starts the lolping server from it with the MCP SDK
// client and calls `say` with FAKE_AGENT_SAY, then `ping` on spot 1, like an agent answering an ask.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

const configAt = process.argv.indexOf('--answer-over-mcp');
if (configAt >= 0) await answerOverMcp(process.argv[configAt + 1]);

if (process.env.FAKE_AGENT_STDERR) process.stderr.write(fill(process.env.FAKE_AGENT_STDERR));
for (const line of JSON.parse(process.env.FAKE_AGENT_LINES ?? '[]')) process.stdout.write(`${fill(line)}\n`);
process.exitCode = Number(process.env.FAKE_AGENT_EXIT ?? 0);

async function answerOverMcp(file) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const server = JSON.parse(readFileSync(file, 'utf8')).mcpServers.lolping;
  const client = new Client({ name: 'fake-agent', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: server.command, args: server.args, env: { ...process.env, ...server.env }, stderr: 'inherit',
  }));
  await client.listTools();
  await client.callTool({ name: 'say', arguments: { text: process.env.FAKE_AGENT_SAY ?? 'Hello.' } });
  await client.callTool({ name: 'ping', arguments: { type: 'danger', spot: 1 } });
  await client.close();
}
