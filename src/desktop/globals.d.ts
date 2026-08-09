export {};

declare global {
  interface Window {
    relayDesktop?: {
      installMcp: () => Promise<string>;
      getStatus: () => Promise<{
        hosted: boolean;
        packaged: boolean;
        portable: boolean;
        canInstallMcp: boolean;
        mcpInstalled: boolean;
        configPath: string;
      }>;
      copyUsagePrompt: () => Promise<string>;
      quit: () => Promise<void>;
    };
  }
}
