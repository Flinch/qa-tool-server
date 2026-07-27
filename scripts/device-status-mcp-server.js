#!/usr/bin/env node
// A tiny MCP server exposing exactly one tool: real iOS simulator boot
// status, straight from `xcrun simctl`. Exists so the maestro-test-*
// agents have a sanctioned way to get this detail without a raw Bash grant.
//
// Security property that matters here: this tool takes NO arguments and
// runs one fixed argv array via execFile (not a shell) — there is no
// agent-controlled string anywhere in the command, so there's nothing to
// inject. Contrast with a `Bash(xcrun simctl list devices*)` allowlist
// pattern, which is a prefix match on a raw shell string and can be
// extended with `;`/`&&`/`|` after the allowed prefix (see DECISIONS.md).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const server = new McpServer({ name: 'device-status', version: '1.0.0' })

server.registerTool(
  'check_ios_simulator',
  {
    description:
      'Real iOS simulator list and boot status, from `xcrun simctl list devices --json`. ' +
      'No arguments — always returns every simulator so you can find yours by name or UDID ' +
      'yourself. Use this instead of list_devices when you need iOS-specific detail (exact ' +
      'state, runtime, or a UDID list_devices doesn\'t surface) — never raw Bash.',
    inputSchema: {},
  },
  async () => {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '--json'])
    return { content: [{ type: 'text', text: stdout }] }
  }
)

await server.connect(new StdioServerTransport())
