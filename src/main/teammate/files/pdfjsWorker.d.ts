// pdfjs ships no types for its worker module; main only hands it to pdfjs (see pdf.ts).
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
