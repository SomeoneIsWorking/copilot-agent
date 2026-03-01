import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import type { NativeToolCall } from '../types';
import { ProcessKiller } from '../ProcessKiller';

export type NativeToolDefinition = {
  name: NativeToolCall['name'];
  description: string;
  inputSchema: unknown;
  execute: (input: Record<string, unknown>) => Promise<string>;
};

export function createNativeToolDefinitions(
  workspacePath: string,
  workspaceRoots: string[],
  processKiller: ProcessKiller,
): NativeToolDefinition[] {
  return [
    {
      name: 'execute_terminal_command',
      description: 'Run a shell command and return stdout/stderr/exit code.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        required: ['command'],
      },
      execute: async (input) => executeTerminalCommand(workspacePath, processKiller, input),
    },
    {
      name: 'edit_file',
      description: 'Replace a line range in a text file.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          startLine: { type: 'number' },
          endLine: { type: 'number' },
          newText: { type: 'string' },
        },
        required: ['filePath', 'startLine', 'endLine', 'newText'],
      },
      execute: async (input) => editFile(workspacePath, input),
    },
    {
      name: 'read_directory',
      description: 'Read directory tree for project mapping.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          depth: { type: 'number' },
          workspaceRoot: { type: 'string' },
        },
      },
      execute: async (input) => readDirectory(workspacePath, workspaceRoots, input),
    },
  ];
}

async function executeTerminalCommand(
  workspacePath: string,
  processKiller: ProcessKiller,
  input: Record<string, unknown>,
): Promise<string> {
  const command = String(input.command ?? '').trim();
  if (!command) {
    throw new Error('execute_terminal_command requires input.command');
  }

  const cwdInput = input.cwd ? String(input.cwd) : workspacePath;
  const cwd = path.isAbsolute(cwdInput) ? cwdInput : path.join(workspacePath, cwdInput);
  const timeoutMs = Number(input.timeoutMs ?? 120000);

  const child = spawn('zsh', ['-lc', command], {
    cwd,
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const childPid = child.pid;
  if (typeof childPid === 'number' && childPid > 0) {
    processKiller.registerPgid(childPid);
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        if (typeof childPid === 'number' && childPid > 0) {
          process.kill(-childPid, 'SIGKILL');
        }
      } catch {
        try {
          if (typeof childPid === 'number' && childPid > 0) {
            process.kill(childPid, 'SIGKILL');
          }
        } catch {
        }
      }
      resolve(124);
    }, timeoutMs);

    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('exit', (code: number | null) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

  if (typeof childPid === 'number' && childPid > 0) {
    processKiller.unregisterPgid(childPid);
  }

  const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
  const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

  return JSON.stringify(
    {
      command,
      cwd,
      exitCode,
      stdout,
      stderr,
    },
    null,
    2,
  );
}

async function editFile(workspacePath: string, input: Record<string, unknown>): Promise<string> {
  const inputPath = String(input.filePath ?? '');
  const startLine = Number(input.startLine ?? 1);
  const endLine = Number(input.endLine ?? startLine);
  const replacement = String(input.newText ?? '');
  if (!inputPath) {
    throw new Error('edit_file requires input.filePath');
  }

  const filePath = path.isAbsolute(inputPath)
    ? inputPath
    : path.join(workspacePath, inputPath);

  const source = await fs.readFile(filePath, 'utf8');
  const lines = source.split(/\r?\n/);
  const clampedStart = Math.max(1, startLine);
  const clampedEnd = Math.min(lines.length, Math.max(clampedStart, endLine));
  const before = lines.slice(0, clampedStart - 1);
  const after = lines.slice(clampedEnd);
  const merged = [...before, ...replacement.split(/\r?\n/), ...after].join('\n');

  await fs.writeFile(filePath, merged, 'utf8');

  return JSON.stringify(
    {
      filePath,
      startLine: clampedStart,
      endLine: clampedEnd,
      replacedLineCount: clampedEnd - clampedStart + 1,
    },
    null,
    2,
  );
}

async function readDirectory(
  workspacePath: string,
  workspaceRoots: string[],
  input: Record<string, unknown>,
): Promise<string> {
  const target = String(input.path ?? '.');
  const depth = Math.max(0, Number(input.depth ?? 4));
  const requestedWorkspaceRoot = input.workspaceRoot ? String(input.workspaceRoot) : undefined;

  if ((target === '.' || target.trim() === '') && workspaceRoots.length > 1) {
    const roots = requestedWorkspaceRoot
      ? workspaceRoots.filter((root) => root === requestedWorkspaceRoot)
      : workspaceRoots;

    const workspaces = await Promise.all(
      roots.map(async (rootPath) => ({
        workspaceRoot: rootPath,
        tree: await walkDirectory(rootPath, depth),
      })),
    );

    return JSON.stringify(
      {
        kind: 'multi-root',
        workspaceCount: workspaces.length,
        workspaces,
      },
      null,
      2,
    );
  }

  const baseRoot = requestedWorkspaceRoot && workspaceRoots.includes(requestedWorkspaceRoot)
    ? requestedWorkspaceRoot
    : workspacePath;
  const fullPath = path.isAbsolute(target) ? target : path.join(baseRoot, target);

  const tree = await walkDirectory(fullPath, depth);
  return JSON.stringify(tree, null, 2);
}

async function walkDirectory(directoryPath: string, depth: number): Promise<unknown> {
  if (depth === 0) {
    return { path: directoryPath, children: [] };
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const children = await Promise.all(
    entries
      .filter((entry: Dirent) => entry.name !== '.git')
      .map(async (entry: Dirent) => {
        const childPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          return {
            name: entry.name,
            type: 'directory',
            children: await walkDirectory(childPath, depth - 1),
          };
        }
        return {
          name: entry.name,
          type: 'file',
        };
      }),
  );

  return {
    path: directoryPath,
    children,
  };
}
