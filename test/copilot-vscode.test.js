import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '../src/parsers/copilot-vscode.js';

function setOverride(value) {
  const previous = process.env.VIBE_USAGE_VSCODE_CHAT_DIRS;
  process.env.VIBE_USAGE_VSCODE_CHAT_DIRS = value;
  return () => {
    if (previous === undefined) delete process.env.VIBE_USAGE_VSCODE_CHAT_DIRS;
    else process.env.VIBE_USAGE_VSCODE_CHAT_DIRS = previous;
  };
}

function writeJournal(filePath, snapshot, updates) {
  writeFileSync(filePath, [
    JSON.stringify({ kind: 0, v: snapshot }),
    ...updates.map(({ kind = 1, k, v }) => JSON.stringify({ kind, k, v })),
  ].join('\n') + '\n');
}

test('parse reconstructs VS Code Chat journals and uses canonical token values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-copilot-vscode-'));
  const userData = join(root, 'User');
  const workspace = join(userData, 'workspaceStorage', 'workspace-id');
  const sessions = join(workspace, 'chatSessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({
    folder: 'vscode-remote://ssh-remote%2Bdemo/home/demo/project',
  }));

  const firstRequest = {
    requestId: 'request-1',
    timestamp: 1784168190000,
    responseTimestamp: 1784168200000,
    modelId: 'gpt-test',
    agent: { extensionId: { value: 'GitHub.copilot-chat' } },
  };
  const secondRequest = {
    requestId: 'request-2',
    timestamp: 1784168300000,
    responseTimestamp: 1784168310000,
    modelId: 'gpt-test',
    agent: { extensionId: { value: 'GitHub.copilot-chat' } },
  };
  const snapshot = {
    version: 3,
    sessionId: 'session-1',
    requests: [firstRequest],
  };
  writeJournal(join(sessions, 'session-1.jsonl'), snapshot, [
    { k: ['requests', 0, 'promptTokens'], v: 100 },
    { k: ['requests', 0, 'completionTokens'], v: 10 },
    { k: ['requests', 0, 'result'], v: { metadata: { promptTokens: 100, outputTokens: 10 } } },
    { kind: 2, k: ['requests'], v: [secondRequest] },
    { k: ['requests', 1, 'promptTokens'], v: 200 },
    { k: ['requests', 1, 'outputTokens'], v: 20 },
    { k: ['requests', 1, 'result'], v: { metadata: { promptTokens: 999, outputTokens: 999 } } },
  ]);

  const restore = setOverride(userData);
  try {
    const result = await parse();
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].source, 'copilot-vscode');
    assert.equal(result.buckets[0].project, 'project');
    assert.equal(result.buckets[0].inputTokens, 300);
    assert.equal(result.buckets[0].outputTokens, 30);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].userMessageCount, 2);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('parse deduplicates copied sessions and keeps the richer request copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-copilot-vscode-copy-'));
  const primary = join(root, 'primary');
  const copy = join(root, 'copy');
  for (const [base, promptTokens] of [[primary, 100], [copy, 250]]) {
    const workspace = join(base, 'workspaceStorage', 'ws');
    const sessions = join(workspace, 'chatSessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ folder: 'file:///work/copied-project' }));
    writeJournal(join(sessions, 'session.jsonl'), {
      version: 3,
      sessionId: 'same-session',
      requests: [{
        requestId: 'same-request',
        timestamp: 1784168190000,
        responseTimestamp: 1784168200000,
        modelId: 'gpt-test',
        agent: { extensionId: { value: 'github.copilot-chat' } },
      }],
    }, [{ k: ['requests', 0, 'promptTokens'], v: promptTokens }, { k: ['requests', 0, 'completionTokens'], v: 5 }]);
  }
  const restore = setOverride([primary, copy].join(delimiter));
  try {
    const result = await parse();
    assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0), 250);
    assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.outputTokens, 0), 5);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('parse survives patch indices beyond the snapshot and still captures provider models', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-copilot-vscode-sparse-'));
  const userData = join(root, 'User');
  const workspace = join(userData, 'workspaceStorage', 'ws');
  const sessions = join(workspace, 'chatSessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ folder: 'file:///work/provider-hop' }));

  writeJournal(join(sessions, 'sparse.jsonl'), {
    version: 3,
    sessionId: 'sparse-session',
    requests: [],
  }, [
    // A request patched in far beyond the snapshot leaves holes at 0..48.
    { k: ['requests', 49, 'promptTokens'], v: 700 },
    { k: ['requests', 49, 'completionTokens'], v: 7 },
    { k: ['requests', 49, 'modelId'], v: 'unify-chat-provider/牛牛/glm-5.3-flash' },
    { k: ['requests', 49, 'agent'], v: { extensionId: { value: 'GitHub.copilot-chat' } } },
    { k: ['requests', 49, 'timestamp'], v: 1784168400000 },
    // Requests without a copilot agent id still carry the user's usage.
    { k: ['requests', 50, 'promptTokens'], v: 50 },
    { k: ['requests', 50, 'outputTokens'], v: 5 },
    { k: ['requests', 50, 'modelId'], v: 'unify-chat-provider/OpenRouter/gpt-x' },
    { k: ['requests', 50, 'agent'], v: 'nullExtensionDescription' },
    { k: ['requests', 50, 'timestamp'], v: 1784168410000 },
  ]);

  const restore = setOverride(userData);
  try {
    const result = await parse();
    const input = result.buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0);
    const output = result.buckets.reduce((sum, bucket) => sum + bucket.outputTokens, 0);
    assert.equal(input, 750);
    assert.equal(output, 12);
    const models = result.buckets.map(bucket => bucket.model).sort();
    assert.deepEqual(models, ['glm-5.3-flash', 'gpt-x']);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});
