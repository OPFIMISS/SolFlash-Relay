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
        tokenMonitorCompatibility: {
          settingsFound: boolean;
          risk: boolean;
          repairable: boolean;
          claudeLimitEnabled: boolean;
          refreshMs: number | null;
          restartRequired: boolean;
          message: string;
          backupPath: string | null;
        };
      }>;
      fixTokenMonitor: () => Promise<{
        settingsFound: boolean;
        risk: boolean;
        repairable: boolean;
        claudeLimitEnabled: boolean;
        refreshMs: number | null;
        restartRequired: boolean;
        message: string;
        backupPath: string | null;
      }>;
      copyUsagePrompt: () => Promise<string>;
      onFocusTask: (listener: (taskId: string) => void) => () => void;
      quit: () => Promise<void>;
    };
  }
}
