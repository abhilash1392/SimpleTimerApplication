const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const ROOT = __dirname;
const DEFAULT_HISTORY_FILE = path.join(ROOT, 'memory.json');
const MAX_BODY_BYTES = 64 * 1024;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/script.js', ['script.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

function jsonResponse(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(data));
}

function isLocalRequest(request, server) {
  const address = server.address();
  if (!address || typeof address === 'string') return false;

  const port = address.port;
  const allowedHosts = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`
  ]);
  const requestHost = request.headers.host;
  if (!requestHost || !allowedHosts.has(requestHost.toLowerCase())) {
    return false;
  }

  const origin = request.headers.origin;
  if (origin) {
    const allowedOrigins = new Set([
      new URL(`http://localhost:${port}`).origin,
      new URL(`http://127.0.0.1:${port}`).origin
    ]);
    if (!allowedOrigins.has(origin)) {
      return false;
    }
  }

  return request.headers['sec-fetch-site'] !== 'cross-site';
}

function normalizeSession(value) {
  // Older version 1 entries omit these fields; normalize them to null when reading.
  const hasEndFields = Object.hasOwn(value || {}, 'endedAt') ||
    Object.hasOwn(value || {}, 'elapsedSeconds');
  const endedAt = value?.endedAt ?? null;
  const elapsedSeconds = value?.elapsedSeconds ?? null;
  const timestampMilliseconds = Date.parse(value?.timestamp);
  const endedAtMilliseconds = endedAt === null ? null : Date.parse(endedAt);

  if (
    !value ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > 200 ||
    typeof value.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    typeof value.timer !== 'string' ||
    value.timer.length === 0 ||
    value.timer.length > 100 ||
    !Number.isSafeInteger(value.timerSeconds) ||
    value.timerSeconds <= 0 ||
    typeof value.completed !== 'boolean' ||
    (endedAt !== null && (!Number.isFinite(endedAtMilliseconds) || endedAtMilliseconds < timestampMilliseconds)) ||
    (elapsedSeconds !== null && (!Number.isSafeInteger(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > value.timerSeconds)) ||
    ((endedAt === null) !== (elapsedSeconds === null)) ||
    (hasEndFields && value.completed && (endedAt === null || elapsedSeconds !== value.timerSeconds))
  ) {
    throw new Error('Invalid timer record.');
  }

  return {
    id: value.id,
    timestamp: value.timestamp,
    timer: value.timer,
    timerSeconds: value.timerSeconds,
    completed: value.completed,
    endedAt,
    elapsedSeconds
  };
}

async function readHistory(historyFile) {
  let contents;
  try {
    contents = await fs.readFile(historyFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { version: 1, sessions: [] };
    }
    throw error;
  }

  let history;
  try {
    history = JSON.parse(contents);
  } catch {
    throw new Error('memory.json is not valid JSON.');
  }

  if (!history || history.version !== 1 || !Array.isArray(history.sessions)) {
    throw new Error('memory.json must contain a version 1 sessions array.');
  }

  return { version: 1, sessions: history.sessions.map(normalizeSession) };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
    } else {
      chunks.push(chunk);
    }
  }
  if (tooLarge) {
    throw new Error('Request body is too large.');
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createServer({ historyFile = DEFAULT_HISTORY_FILE } = {}) {
  // Keep writes ordered so concurrent start/end updates cannot overwrite each other.
  let writeQueue = Promise.resolve();

  async function saveSession(value) {
    const session = normalizeSession(value);
    const operation = writeQueue.then(async () => {
      const history = await readHistory(historyFile);
      const existingIndex = history.sessions.findIndex((entry) => entry.id === session.id);
      if (existingIndex === -1) {
        history.sessions.push(session);
      } else {
        history.sessions[existingIndex] = session;
      }

      const temporaryFile = `${historyFile}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temporaryFile, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
        // Replace the history file only after the complete JSON document is on disk.
        await fs.rename(temporaryFile, historyFile);
      } finally {
        await fs.rm(temporaryFile, { force: true });
      }
      return session;
    });

    writeQueue = operation.catch(() => {});
    return operation;
  }

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');

    try {
      if (requestUrl.pathname === '/api/history' && !isLocalRequest(request, server)) {
        jsonResponse(response, 403, { error: 'History API requests must come from this local timer app.' });
        return;
      }

      if (requestUrl.pathname === '/api/history' && request.method === 'GET') {
        jsonResponse(response, 200, await readHistory(historyFile));
        return;
      }

      if (requestUrl.pathname === '/api/history' && request.method === 'POST') {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          jsonResponse(response, 415, { error: 'Timer records must be sent as JSON.' });
          return;
        }
        const body = await readJsonBody(request);
        const session = await saveSession(body);
        jsonResponse(response, 200, { session });
        return;
      }

      if (request.method === 'GET' && STATIC_FILES.has(requestUrl.pathname)) {
        const [fileName, contentType] = STATIC_FILES.get(requestUrl.pathname);
        const contents = await fs.readFile(path.join(ROOT, fileName));
        response.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store'
        });
        response.end(contents);
        return;
      }

      jsonResponse(response, 404, { error: 'Not found.' });
    } catch (error) {
      const statusCode = error.message === 'Invalid timer record.' ||
        error.message === 'Request body is too large.' ||
        error instanceof SyntaxError
        ? 400
        : 500;
      jsonResponse(response, statusCode, { error: error.message || 'Internal server error.' });
    }
  });

  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Simple Timer is running at http://localhost:${port}`);
    console.log(`Timer history is saved in ${DEFAULT_HISTORY_FILE}`);
  });
  server.on('error', (error) => {
    console.error('Unable to start the timer server.', error);
    process.exitCode = 1;
  });
}

module.exports = { createServer };
