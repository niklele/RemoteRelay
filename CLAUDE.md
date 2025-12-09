# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RemoteRelay is an MCP (Model Context Protocol) server that enables Claude Code to interact with remote development environments over SSH. It provides tools for executing commands, reading/writing files, and navigating directories on remote hosts.

## Build and Development Commands

```bash
# Build the project (required after any TypeScript changes)
npm run build

# Start the compiled server
npm start

# Development mode with ts-node
npm run dev
```

The TypeScript compiler outputs to `dist/` directory. The main entry point is `dist/index.js` (shebang-enabled for CLI execution).

## Architecture

### Core Components

**Single-File Architecture**: All logic resides in `src/index.ts` (~460 lines).

**Connection Model**:
- SSH connections to remote host using ControlMaster for connection pooling
- Commands execute in a persistent tmux session (default: `claude-relay`)
- Working directory state maintained in-memory on the MCP server

**Key Design Patterns**:
- `sshExec()`: Spawns SSH processes with ControlPath for multiplexing
- `tmuxExec()`: Wraps commands to run in tmux, captures output via temp files, polls for completion
- `escapeShell()`: Shell-escapes strings for safe SSH command execution
- All tools use Zod schemas for parameter validation

### State Management

- `currentWorkingDirectory`: Global state tracking remote CWD (null initially)
- All file operations support both absolute and relative paths
- Relative paths are resolved against `currentWorkingDirectory`

### Configuration

Environment variables (set via MCP server config):
- `REMOTE_RELAY_HOST`: SSH hostname (default: "quarry")
- `REMOTE_RELAY_TMUX_SESSION`: tmux session name (default: "claude-relay")
- `SSH_CONTROL_PATH`: Location for SSH control socket

## MCP Server Configuration

MCP servers are configured in `~/.claude.json` under project-specific keys, NOT in `~/.claude/settings.json`.

To register this server:
```bash
claude mcp add remoterelay node /path/to/RemoteRelay/dist/index.js \
  --env REMOTE_RELAY_HOST=your-host \
  --env REMOTE_RELAY_TMUX_SESSION=claude-relay
```

Restart Claude Code after adding or modifying MCP server configuration.

## Available MCP Tools

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `remote_bash` | Execute bash commands in tmux | `command`, `timeout` (optional) |
| `remote_read` | Read file contents | `path`, `offset`, `limit` |
| `remote_write` | Overwrite file contents | `path`, `content` |
| `remote_edit` | String replacement editing | `path`, `old_string`, `new_string` |
| `remote_glob` | Find files by pattern | `pattern`, `path` (optional) |
| `remote_grep` | Search file contents | `pattern`, `path`, `include` |
| `remote_cd` | Change working directory | `path` |
| `remote_pwd` | Show working directory | (none) |
| `remote_ls` | List directory contents | `path`, `all`, `long` |

## Important Implementation Details

### Command Execution Flow (tmuxExec)

1. Ensure tmux session exists (`tmux has-session` or create)
2. Prepend `cd` to command if `currentWorkingDirectory` is set
3. Wrap command to redirect output to temp files: `{ command ; } > output_file 2>&1; echo $? > exit_file`
4. Send wrapped command to tmux with `tmux send-keys`
5. Poll for exit code file (500ms intervals, respects timeout)
6. Read output file, cleanup temp files, return result

### File Operations

- `remote_read`: Uses `cat -n` for line numbers, supports offset/limit with `sed` or `tail`
- `remote_write`: Uses heredoc (delimiter: `REMOTERELAY_EOF`) to handle multiline content
- `remote_edit`: Reads full file, validates uniqueness of `old_string` (errors if 0 or >1 occurrences), performs replacement, writes back

### SSH Connection Pooling

SSH ControlMaster enabled with:
- `ControlPath`: Temp directory socket (`/tmp/remoterelay-ssh-%r@%h:%p`)
- `ControlPersist`: 600 seconds
- Allows multiple SSH commands to reuse a single connection

## TypeScript Configuration

- Target: ES2022
- Module system: NodeNext (ESM)
- Strict mode enabled
- Output: `dist/` directory with declaration files
