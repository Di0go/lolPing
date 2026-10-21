// Stand-in for context-helper in ContextClient tests. Mode comes from argv[2]:
// ok answers everything, silent answers nothing, denied refuses captures for missing permission, slow answers a read
// with its file layer `slow`; after that, like the real helper, it reads nothing more and exits.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
const reply = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let exiting = false;

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

function read(cmd) {
  writeFileSync(join(cmd.dir, 'read-command.json'), JSON.stringify(cmd));
  const out = { type: 'read', id: cmd.id, marks: 'off', marksPath: '', count: 0, text: 'off', file: 'off', boxes: 'off' };
  if (cmd.boxes) Object.assign(out, { boxes: 'ok', boxRects: '90,190,40,20|0,0,1400,1000' });
  if (cmd.marks) {
    const path = join(cmd.dir, `marks-${cmd.id}.tsv`);
    writeFileSync(path, 'button\t900\t700\t200\t60\tSave\n');
    Object.assign(out, { marks: 'ok', marksPath: path, count: 1 });
  }
  if (cmd.text) {
    Object.assign(out, {
      text: 'ok', selection: 'chosen', spotTexts: 'under the spot', focusKind: '', focusLabel: '', focusValue: '',
      focusSecure: false, address: '',
    });
  }
  if (cmd.file && mode === 'slow') {
    out.file = 'slow';
    reply(out);
    exiting = true;
    setTimeout(() => process.exit(0), 200);
    return;
  }
  if (cmd.file) Object.assign(out, { file: 'ok', filePath: 'C:/docs/a.txt', fileAddress: '', how: 'title' });
  reply(out);
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
    else if (cmd.type === 'read') read(cmd);
    else if (cmd.type === 'ping') reply({ type: 'pong', id: cmd.id });
  }
});
process.stdin.on('end', () => process.exit(0));
