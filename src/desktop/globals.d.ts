export {};

declare global {
  interface Window {
    relayDesktop?: {
      installMcp: () => Promise<string>;
      quit: () => Promise<void>;
    };
  }
}
