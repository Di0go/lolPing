// Stand-in for context-helper in ContextClient tests. Mode comes from argv[2]:
// ok answers everything, silent answers nothing, denied refuses captures for missing permission, slow answers
// systemText with `slow`, partial answers marks with `exiting`; after either, like the real helper, it reads nothing
// more and exits.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
const reply = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
/** The helper keeps only the latest capture's grab, for one `marks`. */
let lastCapture = null;
let exiting = false;

function capture(cmd) {
  if (mode === 'denied') return reply({ type: 'error', id: cmd.id, code: 'permission', message: 'Screen Recording is off' });
  writeFileSync(join(cmd.dir, 'command.json'), JSON.stringify(cmd));
  lastCapture = cmd.id;
  const overview = join(cmd.dir, `overview-${cmd.id}.jpg`);
  writeFileSync(overview, 'jpeg');
  const spots = cmd.spots ? cmd.spots.split(';').map((s) => s.split(',').map(Number)) : [];
  const zooms = spots.map((_, i) => join(cmd.dir, `zoom-${cmd.id}-${i + 1}.jpg`));
  for (const z of zooms) writeFileSync(z, 'jpeg');
  const zoomRects = spots.map(([x, y]) => `${x - 500},${y - 375},1000,750`);
  reply({ type: 'captured', id: cmd.id, overview, ow: 1600, oh: 900, zooms: zooms.join(';'), zoomRects: zoomRects.join(';') });
}

function marks(cmd) {
  if (cmd.of !== lastCapture) return reply({ type: 'error', id: cmd.id, code: 'bad', message: 'that capture is gone' });
  writeFileSync(join(cmd.dir, 'marks-command.json'), JSON.stringify(cmd));
  const path = join(cmd.dir, `marks-${cmd.id}.tsv`);
  writeFileSync(path, 'button\t900\t700\t200\t60\tSave\n');
  lastCapture = null;
  if (mode === 'partial') {
    reply({ type: 'marks', id: cmd.id, path, count: 1, exiting: true });
    exitSoon();
    return;
  }
  reply({ type: 'marks', id: cmd.id, path, count: 1 });
}

function exitSoon() {
  exiting = true;
  setTimeout(() => process.exit(0), 200);
}

function systemText(cmd) {
  if (mode === 'slow') {
    reply({ type: 'error', id: cmd.id, code: 'slow', message: 'the system took too long to answer' });
    exitSoon();
    return;
  }
  reply({
    type: 'systemText', id: cmd.id, selection: 'chosen', spotTexts: 'under the spot', focusKind: '', focusLabel: '',
    focusValue: '', focusSecure: false, address: '',
  });
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
    if (mode === 'silent' || exiting) continue;
    if (cmd.type === 'capture') capture(cmd);
    else if (cmd.type === 'foreground') reply({ type: 'foreground', id: cmd.id, app: 'notepad', title: 'notes.txt - Notepad' });
    else if (cmd.type === 'marks') marks(cmd);
    else if (cmd.type === 'systemText') systemText(cmd);
    else if (cmd.type === 'fileOf') reply({ type: 'fileOf', id: cmd.id, path: 'C:/docs/a.txt', address: '', how: 'title' });
    else if (cmd.type === 'ping') reply({ type: 'pong', id: cmd.id });
  }
});
process.stdin.on('end', () => process.exit(0));
