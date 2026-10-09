import { createReadStream, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { projectFromCwd } from './fs-utils.js';

const SOURCE = 'copilot-vscode';

// Model ids in these journals can carry a provider-routing prefix such as
// "unify-chat-provider/<provider>/<model>"; only the trailing model id is
// the user-facing model, other prefixes are kept verbatim.
const CHAT_PROVIDER_PREFIX = 'unify-chat-provider/';

function defaultUserDataRoot() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Code', 'User');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code', 'User');
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdg, 'Code', 'User');
}

function userDataRoots() {
  const override = process.env.VIBE_USAGE_VSCODE_CHAT_DIRS?.trim();
  if (override) return override.split(delimiter).map(s => s.trim()).filter(Boolean);
  return [defaultUserDataRoot()];
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const path of paths) {
    let identity = path;
    try { identity = realpathSync(path); } catch { /* keep literal path */ }
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(path);
  }
  return result;
}

function findSessionFiles(root) {
  const files = [];
  const workspaceStorage = join(root, 'workspaceStorage');
  try {
    for (const workspace of readdirSync(workspaceStorage, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const dir = join(workspaceStorage, workspace.name, 'chatSessions');
      try {
        for (const file of readdirSync(dir, { withFileTypes: true })) {
          if (file.isFile() && file.name.endsWith('.jsonl')) files.push({
            filePath: join(dir, file.name),
            workspacePath: join(workspaceStorage, workspace.name),
          });
        }
      } catch { /* workspace may disappear while VS Code is running */ }
    }
  } catch { /* root is absent or unreadable */ }

  const emptyWindow = join(root, 'globalStorage', 'emptyWindowChatSessions');
  try {
    for (const file of readdirSync(emptyWindow, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.jsonl')) files.push({ filePath: join(emptyWindow, file.name) });
    }
  } catch { /* optional directory */ }
  return uniquePaths(files.map(x => x.filePath)).map(filePath => files.find(x => x.filePath === filePath));
}

function projectFromWorkspace(workspacePath) {
  if (!workspacePath) return 'unknown';
  try {
    const text = readFileSync(join(workspacePath, 'workspace.json'), 'utf8');
    const workspace = JSON.parse(text);
    const folder = workspace.folder;
    if (typeof folder === 'string') {
      const decoded = decodeURIComponent(folder);
      return projectFromCwd(decoded, 'unknown');
    }
  } catch { /* the folder mapping is optional */ }
  return 'unknown';
}

function compactRequest(request) {
  return {
    requestId: request?.requestId,
    responseId: request?.responseId,
    timestamp: request?.timestamp,
    responseTimestamp: request?.responseTimestamp,
    modelId: request?.modelId,
    resolvedModel: request?.resolvedModel,
    agent: request?.agent?.extensionId?.value || request?.agent?.extensionId,
    promptTokens: request?.promptTokens,
    completionTokens: request?.completionTokens,
    outputTokens: request?.outputTokens,
    metadataPromptTokens: request?.result?.metadata?.promptTokens,
    metadataOutputTokens: request?.result?.metadata?.outputTokens,
    promptCalls: 0,
    pendingPrompt: null,
  };
}

function commitPrompt(request) {
  if (request.pendingPrompt !== null) {
    request.promptCalls += request.pendingPrompt;
    request.pendingPrompt = null;
  }
}

async function reconstructJournal(filePath) {
  const requests = [];
  let sessionId;
  let version;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.kind === 0) {
        version = record.v?.version;
        sessionId = record.v?.sessionId;
        requests.length = 0;
        for (const request of record.v?.requests || []) requests.push(compactRequest(request));
        continue;
      }
      const path = record.k;
      if (!Array.isArray(path) || path[0] !== 'requests') continue;
      if (record.kind === 2 && path.length === 1 && Array.isArray(record.v)) {
        for (const request of record.v) requests.push(compactRequest(request));
        continue;
      }
      if (!Number.isInteger(path[1]) || path[1] < 0) continue;
      const index = path[1];
      const request = requests[index] || (requests[index] = compactRequest({}));
      if (record.kind === 1 && path.length === 2) {
        requests[index] = compactRequest(record.v);
        continue;
      }
      if (record.kind !== 1 || path.length !== 3) continue;
      const field = path[2];
      if (field === 'promptTokens') {
        request.promptTokens = record.v;
        request.pendingPrompt = tokenValue(record.v);
      } else if (field === 'result') {
        request.metadataPromptTokens = record.v?.metadata?.promptTokens;
        request.metadataOutputTokens = record.v?.metadata?.outputTokens;
        if (request.pendingPrompt === null && tokenValue(request.metadataPromptTokens) !== null) {
          request.pendingPrompt = tokenValue(request.metadataPromptTokens);
        }
        commitPrompt(request);
      } else if (field === 'completionTokens' || field === 'outputTokens') {
        request[field] = record.v;
      } else if (['requestId', 'responseId', 'timestamp', 'responseTimestamp', 'modelId', 'resolvedModel'].includes(field)) {
        request[field] = record.v;
      } else if (field === 'agent') {
        request.agent = record.v?.extensionId?.value || record.v?.extensionId;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  // Patches may target indices beyond the snapshot, leaving holes in the
  // array; for..of yields those as undefined and they carry no usage.
  for (const request of requests) if (request) commitPrompt(request);
  return version === 3 ? { sessionId, requests } : null;
}

function validTimestamp(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function tokenValue(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function isCopilotRequest(request) {
  const extension = request?.agent;
  const id = typeof extension === 'string' ? extension : extension?.value || extension?._lower;
  return typeof id !== 'string' || id.toLowerCase().includes('github.copilot');
}

function requestUsage(request) {
  const promptTokens = tokenValue(request?.promptCalls || null, request?.promptTokens, request?.metadataPromptTokens);
  const outputTokens = tokenValue(request?.completionTokens, request?.outputTokens, request?.metadataOutputTokens);
  if (promptTokens === null && outputTokens === null) return null;
  return {
    inputTokens: promptTokens || 0,
    outputTokens: outputTokens || 0,
  };
}

function requestModel(request) {
  const model = request?.resolvedModel || request?.modelId;
  if (typeof model !== 'string' || !model) return 'unknown';
  if (model.startsWith(CHAT_PROVIDER_PREFIX)) {
    const segments = model.split('/');
    const id = segments[segments.length - 1];
    if (id) return id;
  }
  return model;
}

function requestKey(sessionId, request) {
  return `${sessionId}|${request?.requestId || request?.responseId || `${request?.timestamp}|${request?.responseTimestamp}`}`;
}

function richness(request) {
  const usage = requestUsage(request);
  return (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
}

async function readCandidate(candidate) {
  const state = await reconstructJournal(candidate.filePath);
  if (!state || !Array.isArray(state.requests)) return null;
  const sessionId = state.sessionId || candidate.filePath;
  const project = projectFromWorkspace(candidate.workspacePath);
  return { sessionId, project, requests: state.requests.filter(request => request && isCopilotRequest(request)) };
}

export async function parse() {
  const candidates = userDataRoots().flatMap(findSessionFiles);
  const byRequest = new Map();
  const projects = new Map();

  for (const candidate of candidates) {
    const session = await readCandidate(candidate);
    if (!session) continue;
    if (!projects.has(session.sessionId) || projects.get(session.sessionId) === 'unknown') {
      projects.set(session.sessionId, session.project);
    }
    for (const request of session.requests) {
      const key = requestKey(session.sessionId, request);
      const previous = byRequest.get(key);
      if (!previous || richness(request) > richness(previous.request)) {
        byRequest.set(key, { sessionId: session.sessionId, project: session.project, request });
      }
    }
  }

  const entries = [];
  const events = [];
  for (const { sessionId, project, request } of byRequest.values()) {
    const timestamp = validTimestamp(request.timestamp);
    if (!timestamp) continue;
    const usage = requestUsage(request);
    if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      entries.push({
        source: SOURCE,
        model: requestModel(request),
        project: project === 'unknown' ? (projects.get(sessionId) || project) : project,
        timestamp,
        ...usage,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      });
    }
    events.push({ sessionId, source: SOURCE, project, timestamp, role: 'user' });
    const responseTimestamp = validTimestamp(request.responseTimestamp || request.result?.timings?.completedAt);
    if (responseTimestamp) events.push({
      sessionId,
      source: SOURCE,
      project,
      timestamp: responseTimestamp,
      role: 'assistant',
    });
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(events),
  };
}

export { reconstructJournal };
