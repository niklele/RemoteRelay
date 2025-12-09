#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execSync } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Configuration
const SSH_HOST = process.env.REMOTE_RELAY_HOST || "quarry";
const TMUX_SESSION = process.env.REMOTE_RELAY_TMUX_SESSION || "claude-relay";
const SSH_CONTROL_PATH = path.join(os.tmpdir(), `remoterelay-ssh-%r@%h:%p`);

// State
let currentWorkingDirectory: string | null = null;

// Helper to run SSH commands
async function sshExec(command: string, options: { timeout?: number } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeout = options.timeout || 60000;

  return new Promise((resolve, reject) => {
    const sshArgs = [
      "-o", `ControlPath=${SSH_CONTROL_PATH}`,
      "-o", "ControlMaster=auto",
      "-o", "ControlPersist=600",
      SSH_HOST,
      command
    ];

    const proc = spawn("ssh", sshArgs, {
      timeout,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

// Helper to run command in tmux and capture output
async function tmuxExec(command: string, options: { timeout?: number } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeout = options.timeout || 60000;
  const outputFile = `/tmp/claude-relay-output-${Date.now()}`;
  const exitCodeFile = `/tmp/claude-relay-exit-${Date.now()}`;

  // Ensure tmux session exists
  await sshExec(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null || tmux new-session -d -s ${TMUX_SESSION}`);

  // Build command with working directory
  let fullCommand = command;
  if (currentWorkingDirectory) {
    fullCommand = `cd ${escapeShell(currentWorkingDirectory)} && ${command}`;
  }

  // Wrap command to capture output and exit code
  const wrappedCommand = `{ ${fullCommand} ; } > ${outputFile} 2>&1; echo $? > ${exitCodeFile}`;

  // Send command to tmux
  await sshExec(`tmux send-keys -t ${TMUX_SESSION} ${escapeShell(wrappedCommand)} Enter`);

  // Wait for command to complete (poll for exit code file)
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const { stdout: exitCodeCheck } = await sshExec(`test -f ${exitCodeFile} && cat ${exitCodeFile}`);
    if (exitCodeCheck.trim() !== "") {
      // Command completed, get output
      const { stdout } = await sshExec(`cat ${outputFile} 2>/dev/null`);
      const exitCode = parseInt(exitCodeCheck.trim(), 10);

      // Cleanup
      await sshExec(`rm -f ${outputFile} ${exitCodeFile}`);

      return { stdout, stderr: "", exitCode };
    }
    // Wait a bit before polling again
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Timeout - cleanup and return error
  await sshExec(`rm -f ${outputFile} ${exitCodeFile}`);
  return { stdout: "", stderr: "Command timed out", exitCode: 124 };
}

// Escape string for shell
function escapeShell(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// Create MCP server
const server = new McpServer({
  name: "RemoteRelay",
  version: "1.0.0",
});

// Tool: remote_bash - Execute command on remote host
server.tool(
  "remote_bash",
  "Execute a bash command on the remote host in a persistent tmux session",
  {
    command: z.string().describe("The bash command to execute"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default: 60000)"),
  },
  async ({ command, timeout }) => {
    try {
      const result = await tmuxExec(command, { timeout });
      const output = result.stdout || "(no output)";
      const status = result.exitCode === 0 ? "success" : `failed (exit code: ${result.exitCode})`;

      return {
        content: [
          {
            type: "text" as const,
            text: `Command: ${command}\nStatus: ${status}\nWorking directory: ${currentWorkingDirectory || "(not set)"}\n\nOutput:\n${output}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error executing command: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: remote_read - Read file contents
server.tool(
  "remote_read",
  "Read the contents of a file on the remote host",
  {
    path: z.string().describe("Path to the file (absolute or relative to working directory)"),
    offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
    limit: z.number().optional().describe("Maximum number of lines to read"),
  },
  async ({ path: filePath, offset, limit }) => {
    try {
      let fullPath = filePath;
      if (!filePath.startsWith("/") && currentWorkingDirectory) {
        fullPath = `${currentWorkingDirectory}/${filePath}`;
      }

      let command = `cat -n ${escapeShell(fullPath)}`;
      if (offset || limit) {
        const start = offset || 1;
        if (limit) {
          command = `sed -n '${start},${start + limit - 1}p' ${escapeShell(fullPath)} | cat -n`;
        } else {
          command = `tail -n +${start} ${escapeShell(fullPath)} | cat -n`;
        }
      }

      const result = await sshExec(command);

      if (result.exitCode !== 0) {
        return {
          content: [{ type: "text" as const, text: `Error reading file: ${result.stderr || result.stdout}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: result.stdout || "(empty file)" }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: remote_write - Write file contents
server.tool(
  "remote_write",
  "Write content to a file on the remote host (overwrites existing)",
  {
    path: z.string().describe("Path to the file (absolute or relative to working directory)"),
    content: z.string().describe("Content to write to the file"),
  },
  async ({ path: filePath, content }) => {
    try {
      let fullPath = filePath;
      if (!filePath.startsWith("/") && currentWorkingDirectory) {
        fullPath = `${currentWorkingDirectory}/${filePath}`;
      }

      // Use heredoc to write content
      const command = `cat > ${escapeShell(fullPath)} << 'REMOTERELAY_EOF'\n${content}\nREMOTERELAY_EOF`;
      const result = await sshExec(command);

      if (result.exitCode !== 0) {
        return {
          content: [{ type: "text" as const, text: `Error writing file: ${result.stderr}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Successfully wrote to ${fullPath}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: remote_edit - Edit file using string replacement
server.tool(
  "remote_edit",
  "Edit a file on the remote host by replacing a string",
  {
    path: z.string().describe("Path to the file (absolute or relative to working directory)"),
    old_string: z.string().describe("The exact string to find and replace"),
    new_string: z.string().describe("The string to replace it with"),
  },
  async ({ path: filePath, old_string, new_string }) => {
    try {
      let fullPath = filePath;
      if (!filePath.startsWith("/") && currentWorkingDirectory) {
        fullPath = `${currentWorkingDirectory}/${filePath}`;
      }

      // First read the file
      const readResult = await sshExec(`cat ${escapeShell(fullPath)}`);
      if (readResult.exitCode !== 0) {
        return {
          content: [{ type: "text" as const, text: `Error reading file: ${readResult.stderr}` }],
          isError: true,
        };
      }

      const originalContent = readResult.stdout;

      // Check if old_string exists and is unique
      const occurrences = originalContent.split(old_string).length - 1;
      if (occurrences === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: old_string not found in file` }],
          isError: true,
        };
      }
      if (occurrences > 1) {
        return {
          content: [{ type: "text" as const, text: `Error: old_string found ${occurrences} times. Please provide more context to make it unique.` }],
          isError: true,
        };
      }

      // Replace and write back
      const newContent = originalContent.replace(old_string, new_string);
      const writeCommand = `cat > ${escapeShell(fullPath)} << 'REMOTERELAY_EOF'\n${newContent}\nREMOTERELAY_EOF`;
      const writeResult = await sshExec(writeCommand);

      if (writeResult.exitCode !== 0) {
        return {
          content: [{ type: "text" as const, text: `Error writing file: ${writeResult.stderr}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Successfully edited ${fullPath}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: remote_glob - Find files by pattern
server.tool(
  "remote_glob",
  "Find files matching a glob pattern on the remote host",
  {
    pattern: z.string().describe("Glob pattern to match (e.g., '**/*.ts', 'src/*.js')"),
    path: z.string().optional().describe("Directory to search in (default: working directory)"),
  },
  async ({ pattern, path: searchPath }) => {
    try {
      const dir = searchPath || currentWorkingDirectory || ".";

      // Use find with -name or fd if available
      const command = `cd ${escapeShell(dir)} && find . -type f -name ${escapeShell(pattern)} 2>/dev/null | head -100 | sort`;
      const result = await sshExec(command);

      if (result.exitCode !== 0 && result.stderr) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.stderr}` }],
          isError: true,
        };
      }

      const files = result.stdout.trim() || "(no matches)";
      return {
        content: [{ type: "text" as const, text: `Files matching '${pattern}' in ${dir}:\n${files}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: remote_grep - Search file contents
server.tool(
  "remote_grep",
  "Search for a pattern in files on the remote host",
  {
    pattern: z.string().describe("Regular expression pattern to search for"),
    path: z.string().optional().describe("File or directory to search (default: working directory)"),
    include: z.string().optional().describe("File pattern to include (e.g., '*.ts')"),
  },
  async ({ pattern, path: searchPath, include }) => {
    try {
      const dir = searchPath || currentWorkingDirectory || ".";

      let command = `grep -rn ${escapeShell(pattern)} ${escapeShell(dir)}`;
      if (include) {
        command = `grep -rn --include=${escapeShell(include)} ${escapeShell(pattern)} ${escapeShell(dir)}`;
      }
      command += " 2>/dev/null | head -50";

      const result = await sshExec(command);

      const matches = result.stdout.trim() || "(no matches)";
      return {
        content: [{ type: "text" as const, text: `Grep results for '${pattern}':\n${matches}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: remote_cd - Change working directory
server.tool(
  "remote_cd",
  "Change the current working directory on the remote host",
  {
    path: z.string().describe("Directory path to change to"),
  },
  async ({ path: newPath }) => {
    try {
      // Resolve the path
      let targetPath = newPath;
      if (!newPath.startsWith("/") && currentWorkingDirectory) {
        targetPath = `${currentWorkingDirectory}/${newPath}`;
      }

      // Verify the directory exists
      const result = await sshExec(`cd ${escapeShell(targetPath)} && pwd`);

      if (result.exitCode !== 0) {
        return {
          content: [{ type: "text" as const, text: `Error: Directory does not exist or is not accessible: ${newPath}` }],
          isError: true,
        };
      }

      currentWorkingDirectory = result.stdout.trim();
      return {
        content: [{ type: "text" as const, text: `Working directory changed to: ${currentWorkingDirectory}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: remote_pwd - Show current working directory
server.tool(
  "remote_pwd",
  "Show the current working directory on the remote host",
  {},
  async () => {
    return {
      content: [{ type: "text" as const, text: `Current working directory: ${currentWorkingDirectory || "(not set - use remote_cd to set)"}` }],
    };
  }
);

// Tool: remote_ls - List directory contents
server.tool(
  "remote_ls",
  "List contents of a directory on the remote host",
  {
    path: z.string().optional().describe("Directory to list (default: working directory)"),
    all: z.boolean().optional().describe("Include hidden files"),
    long: z.boolean().optional().describe("Use long listing format"),
  },
  async ({ path: dirPath, all, long }) => {
    try {
      const dir = dirPath || currentWorkingDirectory || ".";
      let flags = "";
      if (all) flags += "a";
      if (long) flags += "l";
      if (flags) flags = `-${flags}`;

      const command = `ls ${flags} ${escapeShell(dir)}`;
      const result = await sshExec(command);

      if (result.exitCode !== 0) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.stderr || result.stdout}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Contents of ${dir}:\n${result.stdout}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("RemoteRelay MCP server started");
}

main().catch(console.error);
