// Stand-in for context-helper in ContextClient tests. Mode comes from argv[2]:
// ok answers everything, silent answers nothing, denied refuses captures for missing permission.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
const reply = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

function capture(cmd) {
  if (mode === 'denied') return reply({ type: 'error', id: cmd.id, code: 'permission', message: 'Screen Recording is off' });
  writeFileSync(join(cmd.dir, 'command.json'), JSON.stringify(cmd));
  const overview = join(cmd.dir, `overview-${cmd.id}.jpg`);
  writeFileSync(overview, 'jpeg');
  const spots = cmd.spots ? cmd.spots.split(';').map((s) => s.split(',').map(Number)) : [];
  const zooms = spots.map((_, i) => join(cmd.dir, `zoom-${cmd.id}-${i + 1}.jpg`));
  for (const z of zooms) writeFileSync(z, 'jpeg');
  const zoomRects = spots.map(([x, y]) => `${x - 500},${y - 375},1000,750`);
  reply({ type: 'captured', id: cmd.id, overview, ow: 1600, oh: 900, zooms: zooms.join(';'), zoomRects: zoomRects.join(';') });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const cmd = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (cmd.type === 'shutdown') process.exit(0);
    if (mode === 'silent') continue;
    if (cmd.type === 'capture') capture(cmd);
    else if (cmd.type === 'foreground') reply({ type: 'foreground', id: cmd.id, app: 'notepad', title: 'notes.txt - Notepad' });
    else if (cmd.type === 'ping') reply({ type: 'pong', id: cmd.id });
  }
});
process.stdin.on('end', () => process.exit(0));
