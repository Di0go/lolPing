/**
 * Reads a server-sent event stream and calls `onEvent` with each event's name (`message` when unnamed) and its data
 * lines joined. Stops, cancelling the body, when `onEvent` throws or `signal` aborts.
 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let data: string[] = [];
  const line = (l: string): void => {
    if (l === '') {
      // One chunk can hold many events; none of them may reach onEvent after an abort.
      if (signal?.aborted) throw signal.reason;
      if (data.length > 0) onEvent(event || 'message', data.join('\n'));
      event = '';
      data = [];
      return;
    }
    if (l.startsWith(':')) return;
    const colon = l.indexOf(':');
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  // Some fetch implementations keep a body readable after an abort, so the abort cancels the reader itself.
  const onAbort = (): void => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const i = buf.search(/[\r\n]/);
        // A CR at the end may be the first half of a CRLF split across chunks.
        if (i < 0 || (buf[i] === '\r' && i === buf.length - 1)) break;
        const end = buf[i] === '\r' && buf[i + 1] === '\n' ? i + 2 : i + 1;
        line(buf.slice(0, i));
        buf = buf.slice(end);
      }
    }
    buf += decoder.decode();
    for (const l of buf.split(/\r\n|\r|\n/)) line(l);
    line('');
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
