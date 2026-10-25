import type { MateApi } from '../../shared/teammateIpc';

declare global {
  interface Window {
    mateApi: MateApi;
  }
}

export {};
