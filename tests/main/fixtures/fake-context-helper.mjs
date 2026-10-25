// Stand-in for context-helper in ContextClient tests. Mode comes from argv[2]:
// ok answers everything (a paste with ok, not restored for the text "clipboard held"; a setField with refused),
// silent answers nothing, denied refuses captures for missing permission, slow answers a read with its file layer
// `slow`; after that, like the real helper, it reads nothing more and exits. lagged answers a foreground after 300 ms
// and a paste after 1.5 s, writing the file the paste's text names as it answers. Like the real helper, it runs one
// command at a time, shutdown and the end of its input included.
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
  const out = { type: 'read', id: cmd.id, marks: 'off', marksPath: '', count: 0, text: 'off', file: 'off', boxes: 'off', fields: 'off' };
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
  if (cmd.fields) {
    const path = join(cmd.dir, `fields-${cmd.id}.jsonl`);
    const field = {
      id: '42.7.1', kind: 'text', label: 'Name', group: '', value: 'Ada', secure: false, required: true, options: [],
    };
    writeFileSync(path, `${JSON.stringify(field)}\n`);
    Object.assign(out, { fields: 'ok', fieldsPath: path, fieldCount: 1 });
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

const later = (ms) => new Promise((resolve) => setTimeout(resolve, mode === 'lagged' ? ms : 0));

async function handle(cmd) {
  if (cmd.type === 'shutdown') process.exit(0);
  if (mode === 'silent' || exiting) return;
  if (cmd.type === 'capture') capture(cmd);
  else if (cmd.type === 'foreground') {
    await later(300);
    reply({ type: 'foreground', id: cmd.id, app: 'notepad', title: 'notes.txt - Notepad', window: '263544', pid: 4242 });
  }
  else if (cmd.type === 'front') {
    reply({ type: 'front', id: cmd.id, window: '263544', title: 'notes.txt - Notepad', x: -1920, y: 40, w: 900, h: 700, pid: 4242 });
  }
  else if (cmd.type === 'read') read(cmd);
  else if (cmd.type === 'ping') reply({ type: 'pong', id: cmd.id });
  else if (cmd.type === 'paste') {
    await later(1500);
    if (mode === 'lagged') writeFileSync(cmd.text, 'pasted');
    const held = cmd.text === 'clipboard held';
    reply({ type: 'pasted', id: cmd.id, result: 'ok', ...(held ? { restored: false } : {}) });
  }
  else if (cmd.type === 'setField') reply({ type: 'set', id: cmd.id, result: 'refused' });
}

let buf = '';
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const cmd = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    queue = queue.then(() => handle(cmd));
  }
});
process.stdin.on('end', () => {
  queue = queue.then(() => process.exit(0));
});
