# RemoteRelay

An MCP (Model Context Protocol) server that enables Claude Code to interact with remote development environments over SSH.

## Overview

RemoteRelay bridges Claude Code with your remote servers, allowing you to execute commands, read/write files, and navigate directories on remote hosts—all through Claude's natural language interface. Commands run in a persistent tmux session, maintaining context across operations.

## Features

- **Remote Command Execution**: Run bash commands in a persistent tmux session
- **File Operations**: Read, write, and edit files on remote hosts
- **Directory Navigation**: Change directories with state preserved across commands
- **File Search**: Find files by glob patterns and search contents with grep
- **SSH Connection Pooling**: Efficient connection reuse via SSH ControlMaster
- **Working Directory State**: Remote CWD maintained across all operations

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd RemoteRelay

# Install dependencies
npm install

# Build the project
npm run build
```

## Configuration

### 1. Configure MCP Server

Add RemoteRelay to Claude Code's MCP configuration:

```bash
claude mcp add remoterelay node /path/to/RemoteRelay/dist/index.js \
  --env REMOTE_RELAY_HOST=your-remote-host \
  --env REMOTE_RELAY_TMUX_SESSION=claude-relay
```

### 2. SSH Setup

Ensure you have SSH access to your remote host configured with key-based authentication:

```bash
# Test SSH connection
ssh your-remote-host

# Recommended: Add to ~/.ssh/config for easier access
Host your-remote-host
    HostName actual.hostname.com
    User your-username
    IdentityFile ~/.ssh/id_rsa
```

### 3. Restart Claude Code

After adding the MCP server, restart Claude Code to load the configuration.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `REMOTE_RELAY_HOST` | SSH hostname to connect to | `quarry` |
| `REMOTE_RELAY_TMUX_SESSION` | Name of tmux session for command execution | `claude-relay` |

## Available Tools

RemoteRelay provides the following MCP tools:

| Tool | Description |
|------|-------------|
| `remote_bash` | Execute bash commands on remote host |
| `remote_read` | Read file contents with optional offset/limit |
| `remote_write` | Write content to files (overwrites existing) |
| `remote_edit` | Edit files using string replacement |
| `remote_glob` | Find files matching glob patterns |
| `remote_grep` | Search file contents with regex patterns |
| `remote_cd` | Change working directory |
| `remote_pwd` | Show current working directory |
| `remote_ls` | List directory contents |

## Usage Examples

Once configured, interact with your remote environment through Claude Code:

```
User: Use remote_cd to navigate to ~/my-project
User: Run npm test on the remote host
User: Read the file src/main.js
User: Search for TODO comments in the codebase
User: Edit config.json to change the port from 3000 to 8080
```

## Monitoring

Attach to the tmux session on your remote host to monitor command execution:

```bash
# On your remote host
tmux attach -t claude-relay
```

## Development

```bash
# Build TypeScript
npm run build

# Development mode with auto-reload
npm run dev

# Start the server directly
npm start
```

## Architecture

- **Single-file design**: All logic in `src/index.ts`
- **SSH ControlMaster**: Connection pooling for efficiency
- **Tmux integration**: Persistent session for command execution
- **Stateful operations**: Working directory maintained across commands

## Requirements

- Node.js 16+
- TypeScript 5+
- SSH access to remote host
- tmux installed on remote host

## License

MIT License - see [LICENSE.md](LICENSE.md) for details.

## Contributing

This project was created to enable remote development workflows with Claude Code and as part of my experimentation with using Claude Code, so I won't be accepting contributions.
