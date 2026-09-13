import { EnvironmentError } from './browser.js';

/** Placeholder until Task 5 wires the Model Context Protocol server. */
export async function serveMcp(): Promise<void> {
  throw new EnvironmentError('the MCP server is not available in this build');
}
