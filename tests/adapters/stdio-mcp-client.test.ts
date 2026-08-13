import { describe, expect, it } from 'vitest';

import { StdioMcpClient } from '../../src/adapters/stdio-mcp-client.js';

describe('StdioMcpClient', () => {
  it('initializes an MCP server and returns the tools/call result', async () => {
    const script = [
      "const readline=require('node:readline');",
      "readline.createInterface({input:process.stdin}).on('line', line => {",
      "const m=JSON.parse(line); if(m.id===undefined)return;",
      "const result=m.method==='tools/call'?{data:{content:process.env.AIW_MCP_TEST_VALUE}}:{protocolVersion:'2024-11-05',capabilities:{}};",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');",
      "});",
    ].join('');
    const client = new StdioMcpClient();

    const result = await client.callTool({
      server: { args: ['-e', script], command: process.execPath, env: { AIW_MCP_TEST_VALUE: '# Refund' }, transport: 'stdio' },
      tool: 'docx_v1_document_rawContent',
      arguments: { path: { document_id: 'doccn123' } },
    });

    expect(result).toEqual({ data: { content: '# Refund' } });
  });

  it('lists MCP tools after initialization', async () => {
    const script = [
      "const readline=require('node:readline');",
      "readline.createInterface({input:process.stdin}).on('line', line => {",
      "const m=JSON.parse(line); if(m.id===undefined)return;",
      "const result=m.method==='tools/list'?{tools:[{name:'docx_v1_document_rawContent'},{name:'other'}]}:{protocolVersion:'2024-11-05',capabilities:{}};",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');",
      "});",
    ].join('');

    await expect(new StdioMcpClient().listTools({
      server: { args: ['-e', script], command: process.execPath, env: {}, transport: 'stdio' },
    })).resolves.toEqual([{ name: 'docx_v1_document_rawContent' }, { name: 'other' }]);
  });
});
