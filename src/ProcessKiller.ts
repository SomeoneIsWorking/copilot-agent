import * as vscode from 'vscode';

export class ProcessKiller {
  private readonly activePgids = new Set<number>();
  private cancellationSource: vscode.CancellationTokenSource;

  constructor(cancellationSource: vscode.CancellationTokenSource) {
    this.cancellationSource = cancellationSource;
  }

  get token(): vscode.CancellationToken {
    return this.cancellationSource.token;
  }

  registerPgid(pgid: number): void {
    if (Number.isFinite(pgid) && pgid > 0) {
      this.activePgids.add(pgid);
    }
  }

  unregisterPgid(pgid: number): void {
    this.activePgids.delete(pgid);
  }

  async hardStop(): Promise<void> {
    this.cancellationSource.cancel();
    await this.terminateAllTrackedProcessGroups();
    this.resetCancellationToken();
  }

  resetCancellationToken(): void {
    this.cancellationSource.dispose();
    this.cancellationSource = new vscode.CancellationTokenSource();
  }

  private async terminateAllTrackedProcessGroups(): Promise<void> {
    const pgids = Array.from(this.activePgids.values());
    await Promise.all(
      pgids.map(async (pgid) => {
        this.killProcessGroup(pgid, 'SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 400));
        this.killProcessGroup(pgid, 'SIGKILL');
      }),
    );
    this.activePgids.clear();
  }

  private killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pgid, signal);
    } catch {
      try {
        process.kill(pgid, signal);
      } catch {
      }
    }
  }
}
