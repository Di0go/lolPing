import { describe, expect, it } from 'vitest';
import { AskMachine } from '../../../src/shared/teammate/askMachine';

function make() {
  let t = 1000;
  const m = new AskMachine(() => t);
  return { m, advance: (ms: number) => { t += ms; } };
}

describe('AskMachine', () => {
  it('fails as notReceived 10 s after sending', () => {
    const { m, advance } = make();
    m.startGathering();
    m.sent();
    advance(9_999);
    expect(m.tick()).toBeNull();
    advance(1);
    expect(m.tick()).toBe('notReceived');
    expect(m.phase).toBe('failed');
    expect(m.accepts()).toBe(false);
  });

  it('times out 60 s after sending even while answering', () => {
    const { m, advance } = make();
    m.sent();
    advance(2_000);
    expect(m.received()).toBe(true);
    m.answering();
    advance(57_999);
    expect(m.tick()).toBeNull();
    advance(1);
    expect(m.tick()).toBe('timeout');
    expect(m.phase).toBe('failed');
  });

  it('stops accepting after cancel', () => {
    const { m } = make();
    expect(m.accepts()).toBe(true);
    m.cancel();
    expect(m.phase).toBe('cancelled');
    expect(m.accepts()).toBe(false);
    m.fail('network');
    expect(m.phase).toBe('cancelled');
  });

  it('reports received only once', () => {
    const { m } = make();
    m.sent();
    expect(m.received()).toBe(true);
    expect(m.received()).toBe(false);
  });

  it('gives every ask its own id', () => {
    const now = () => 5;
    expect(new AskMachine(now).id).not.toBe(new AskMachine(now).id);
  });
});
