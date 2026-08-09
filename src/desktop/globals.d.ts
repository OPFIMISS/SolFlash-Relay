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
        unreadTasks: number;
      }>;
      copyUsagePrompt: () => Promise<string>;
      onFocusTask: (listener: (taskId: string) => void) => () => void;
      quit: () => Promise<void>;
    };
  }
}
