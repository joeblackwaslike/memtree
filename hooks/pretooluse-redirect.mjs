#!/usr/bin/env node
/**
 * PreToolUse hook — hard-redirects native Read/Grep/Bash/WebFetch/PowerShell/Monitor
 * to ctx-tree equivalents. Agent enrichment is handled by a separate hook. Emits permissionDecision:deny so the original call is blocked,
 * then injects the exact replacement call as additionalContext.
 */

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.fs', '.fsx',
  '.sh', '.bash', '.zsh', '.fish',
  '.yaml', '.yml', '.json', '.jsonc', '.toml', '.hcl', '.tf', '.tfvars',
  '.graphql', '.gql', '.proto', '.sql',
  '.css', '.scss', '.sass', '.less',
  '.html', '.svelte', '.vue',
  '.md', '.mdx', '.rst',
]);

const GREP_COMMANDS    = new Set(['grep', 'rg', 'ag', 'egrep', 'fgrep', 'ack', 'ripgrep']);
const CAT_COMMANDS     = new Set(['cat', 'bat']);
const PS_GREP_COMMANDS = new Set(['select-string', 'sls', 'findstr']);
const PS_CAT_COMMANDS  = new Set(['get-content', 'gc', 'type']);
const PS_FETCH_COMMANDS = new Set(['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'curl', 'wget']);

function getExt(filePath) {
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
}

function deny(reason, context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
      additionalContext: context,
    },
  }));
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const toolName  = String(input.tool_name  ?? '').toLowerCase();
const toolInput = input.tool_input ?? {};

// ── Read ──────────────────────────────────────────────────────────────────────
if (toolName === 'read') {
  const filePath = String(toolInput.file_path ?? toolInput.filePath ?? '');
  if (filePath && CODE_EXTENSIONS.has(getExt(filePath))) {
    const extra = toolInput.lines
      ? `, lines: ${JSON.stringify(toolInput.lines)}`
      : '';
    deny(
      `Use ctx_tree_read instead of Read for "${filePath}".`,
      `Call: ctx_tree_read({ path: ${JSON.stringify(filePath)}${extra} })\n\nReturns content up to budget_tokens (default 2000), truncating large symbols to fit — pass a larger budget_tokens for more. Also symbol-chunks the file and stores nodes (full, untruncated content) for the chunks it returns, returning nodeIds you can pass to ctx_tree_neighbors to find related code.`,
    );
  }
}

// ── Grep ──────────────────────────────────────────────────────────────────────
if (toolName === 'grep') {
  const pattern = String(toolInput.pattern ?? toolInput.regex ?? '');
  const path    = String(toolInput.path ?? toolInput.include ?? '');
  const pathArg = path ? `, path: ${JSON.stringify(path)}` : '';
  deny(
    `Use ctx_tree_grep instead of Grep.`,
    `Call: ctx_tree_grep({ pattern: ${JSON.stringify(pattern)}${pathArg} })\n\nReturns matches up to budget_tokens (default 2000) — pass a larger budget_tokens for more. Stores every match as a graph node so you can revisit via ctx_tree_search or ctx_tree_neighbors without re-running the search.`,
  );
}

// ── Bash ──────────────────────────────────────────────────────────────────────
if (toolName === 'bash') {
  const command = String(toolInput.command ?? '').trim();

  // Skip piped / compound commands — too risky to partially intercept
  if (command.includes('|') || command.includes(';') || command.includes('&&')) {
    process.exit(0);
  }

  const parts   = command.split(/\s+/);
  const cmdName = parts[0].split('/').pop().toLowerCase();

  if (GREP_COMMANDS.has(cmdName)) {
    // Extract a best-effort pattern + path from the grep command
    const nonFlagArgs = parts.slice(1).filter(p => !p.startsWith('-'));
    const pattern = nonFlagArgs[0] ?? '';
    const searchPath = nonFlagArgs[1] ?? '.';
    deny(
      `Use ctx_tree_grep instead of ${cmdName}.`,
      `Call: ctx_tree_grep({ pattern: ${JSON.stringify(pattern)}, path: ${JSON.stringify(searchPath)} })\n\nReturns matches up to budget_tokens (default 2000), stored as graph nodes.`,
    );
  }

  if (CAT_COMMANDS.has(cmdName)) {
    const filePath = parts.slice(1).find(p => !p.startsWith('-')) ?? '';
    if (filePath && CODE_EXTENSIONS.has(getExt(filePath))) {
      deny(
        `Use ctx_tree_read instead of ${cmdName} for "${filePath}".`,
        `Call: ctx_tree_read({ path: ${JSON.stringify(filePath)} })\n\nReturns content up to budget_tokens (default 2000) and stores symbol-chunked nodes in the session graph.`,
      );
    }
  }
}

// ── WebFetch ──────────────────────────────────────────────────────────────────
if (toolName === 'webfetch') {
  const url = String(toolInput.url ?? toolInput.uri ?? '');
  deny(
    `Use ctx_tree_browse instead of WebFetch for "${url}".`,
    `Call: ctx_tree_browse({ url: ${JSON.stringify(url)} })\n\nReturns a compact structured reference (title, key sections, nodeId) instead of raw HTML. Stores the page as a web_chunk node so you can revisit via ctx_tree_neighbors or ctx_tree_search.`,
  );
}

// ── PowerShell ────────────────────────────────────────────────────────────────
if (toolName === 'powershell') {
  const script = String(toolInput.command ?? toolInput.script ?? toolInput.code ?? '').trim();

  // Skip compound scripts — too risky to partially intercept
  if (script.includes('|') || script.includes(';')) {
    process.exit(0);
  }

  const parts   = script.split(/\s+/);
  const cmdName = parts[0].toLowerCase();

  if (PS_GREP_COMMANDS.has(cmdName)) {
    // Select-String -Pattern <pat> [-Path <path>]
    const patternIdx = parts.findIndex(p => p.toLowerCase() === '-pattern');
    const pattern = patternIdx >= 0 ? (parts[patternIdx + 1] ?? '') : (parts[1] ?? '');
    const pathIdx = parts.findIndex(p => p.toLowerCase() === '-path');
    const searchPath = pathIdx >= 0 ? (parts[pathIdx + 1] ?? '.') : '.';
    deny(
      `Use ctx_tree_grep instead of ${parts[0]}.`,
      `Call: ctx_tree_grep({ pattern: ${JSON.stringify(pattern)}, path: ${JSON.stringify(searchPath)} })\n\nReturns matches up to budget_tokens (default 2000), stored as graph nodes.`,
    );
  }

  if (PS_CAT_COMMANDS.has(cmdName)) {
    const filePath = parts.slice(1).find(p => !p.startsWith('-')) ?? '';
    if (filePath && CODE_EXTENSIONS.has(getExt(filePath))) {
      deny(
        `Use ctx_tree_read instead of ${parts[0]} for "${filePath}".`,
        `Call: ctx_tree_read({ path: ${JSON.stringify(filePath)} })\n\nReturns content up to budget_tokens (default 2000) and stores symbol-chunked nodes in the session graph.`,
      );
    }
  }

  if (PS_FETCH_COMMANDS.has(cmdName)) {
    const uriIdx = parts.findIndex(p => p.toLowerCase() === '-uri' || p.toLowerCase() === '-url');
    const url = uriIdx >= 0 ? (parts[uriIdx + 1] ?? '') : (parts[1] ?? '');
    deny(
      `Use ctx_tree_browse instead of ${parts[0]} for "${url}".`,
      `Call: ctx_tree_browse({ url: ${JSON.stringify(url)} })\n\nReturns a compact structured reference stored as a web_chunk node.`,
    );
  }
}

// ── Monitor ───────────────────────────────────────────────────────────────────
if (toolName === 'monitor') {
  const command = String(toolInput.command ?? toolInput.cmd ?? '');
  deny(
    `Use ctx_tree_monitor instead of Monitor for "${command.slice(0, 60)}".`,
    `Call: ctx_tree_monitor({ command: ${JSON.stringify(command)} })\n\nRuns the command, captures ALL output to a stored node, returns a compact reference (nodeId + preview). Output never floods context — retrieve any portion via ctx_tree_compose([nodeId], budget_tokens).`,
  );
}

// ── WebSearch ─────────────────────────────────────────────────────────────────
// Not blocked — search results are compact already and we have no ctx-tree
// replacement yet. PostToolUse hook handles compaction once results arrive.
// (ctx_tree_web_search is a future tool)

// No redirect needed — allow the call
process.exit(0);
