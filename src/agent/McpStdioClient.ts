import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { MCPListedTool } from '../types';
import { ProcessKiller } from '../ProcessKiller';

export class McpStdioClient {
  private child!: ChildProcessWithoutNullStreams;
  private requestId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private stdoutBuffer = Buffer.alloc(0);

  constructor(
    private readonly serverName: string,
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly cwd: string,
    private readonly processKiller: ProcessKiller,
  ) {}

  async connect(): Promise<void> {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const childPid = this.child.pid;
    if (typeof childPid === 'number' && childPid > 0) {
      this.processKiller.registerPgid(childPid);
    }

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
      this.readFrames();
    });

    this.child.on('error', (error: Error) => {
      this.rejectAll(new Error(`${this.serverName} failed: ${error.message}`));
    });

    this.child.on('exit', (code: number | null) => {
      if (typeof childPid === 'number' && childPid > 0) {
        this.processKiller.unregisterPgid(childPid);
      }
      this.rejectAll(new Error(`${this.serverName} exited with code ${code ?? 1}`));
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'branching-timeline-agent',
        version: '0.1.0',
      },
    });

    await this.request('notifications/initialized', {});
  }

  async listTools(): Promise<MCPListedTool[]> {
    const response = await this.request('tools/list', {});
    const tools = response?.tools;
    if (!Array.isArray(tools)) {
      return [];
    }
    return tools.map((tool) => ({
      name: String(tool.name),
      description: typeof tool.description === 'string' ? tool.description : undefined,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', {
      name,
      arguments: input,
    });
  }

  private async request(method: string, params: unknown): Promise<any> {
    const id = this.requestId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const payloadText = JSON.stringify(payload);
    const frame = `Content-Length: ${Buffer.byteLength(payloadText, 'utf8')}\r\n\r\n${payloadText}`;

    const response = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.child.stdin.write(frame, 'utf8');
    return response;
  }

  private readFrames(): void {
    while (true) {
      const headerEnd = this.stdoutBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }

      const headerText = this.stdoutBuffer.slice(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        this.stdoutBuffer = this.stdoutBuffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.stdoutBuffer.length < bodyEnd) {
        return;
      }

      const body = this.stdoutBuffer.slice(bodyStart, bodyEnd).toString('utf8');
      this.stdoutBuffer = this.stdoutBuffer.slice(bodyEnd);

      let message: any;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }

      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const request = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) {
          request.reject(new Error(JSON.stringify(message.error)));
        } else {
          request.resolve(message.result);
        }
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
