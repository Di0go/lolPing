import type { ToolDef } from '../../../shared/teammate/tools';

export type Part = { text: string } | { image: { mime: 'image/jpeg'; data: Buffer } };

/** A tool call as the model sent it; arguments stay a JSON string until the controller parses them. */
export interface RawCall { id: string; name: string; args: string }

export type Turn =
  | { role: 'user'; parts: Part[] }
  | { role: 'assistant'; text: string; calls: RawCall[] }
  | { role: 'tool'; results: { id: string; content: Part[] }[] };

export interface StreamHandlers {
  /** The provider started answering: the first streamed event arrived. */
  accepted(): void;
  text(delta: string): void;
  /** One tool call finished streaming, before the turn ends; the turn's result has the same call again. */
  call?(c: RawCall): void;
  usage(u: { input: number; output: number }): void;
}

export interface TurnResult { text: string; calls: RawCall[] }

export interface ProviderAdapter {
  turn(
    req: { system: string; turns: Turn[]; tools: ToolDef[]; model: string },
    h: StreamHandlers,
    signal: AbortSignal,
  ): Promise<TurnResult>;
  listModels(signal: AbortSignal): Promise<string[]>;
}

export type ProviderErrorKind = 'auth' | 'rate' | 'network' | 'images' | 'tools' | 'other';

export class ProviderError extends Error {
  constructor(readonly kind: ProviderErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}
