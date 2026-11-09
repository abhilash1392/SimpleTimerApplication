const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { createServer } = require('../server');
const script = require('node:fs').readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

async function withTimerServer(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-timer-test-'));
  const historyFile = path.join(directory, 'memory.json');
  const server = createServer({ historyFile });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await run({ baseUrl, historyFile });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function createTimerPage(baseUrl, clock) {
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock.now]));
    }

    static now() {
      return clock.now;
    }
  }

  class Element {
    constructor(dataset = {}) {
      this.dataset = dataset;
      this.listeners = {};
      this.attributes = {};
      this.textContent = '';
      this.value = '';
      this.disabled = false;
    }

    addEventListener(name, callback) {
      this.listeners[name] = callback;
    }

    setAttribute(name, value) {
      this.attributes[name] = value;
    }

    click() {
      return this.listeners.click?.();
    }

    focus() {}
  }

  const selectors = [
    '#duration',
    '#time-display',
    '#validation-message',
    '#audio-status',
    '#history-status',
    '#run-button',
    '#pause-button',
    '#stop-button',
    '#export-history-button'
  ];
  const elements = Object.fromEntries(selectors.map((selector) => [selector, new Element()]));
  let intervalCallback = null;
  let intervalId = 0;
  let sessionId = 0;

  const audioContext = {
    state: 'running',
    currentTime: 0,
    destination: {},
    createOscillator() {
      return {
        frequency: { setValueAtTime() {} },
        connect() {},
        start() {},
        stop() {}
      };
    },
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {}
      };
    }
  };
  const window = {
    AudioContext: function AudioContext() { return audioContext; },
    crypto: { randomUUID: () => `test-session-${++sessionId}` },
    setInterval(callback) {
      intervalCallback = callback;
      return ++intervalId;
    },
    clearInterval() {
      intervalCallback = null;
    },
    setTimeout
  };
  const document = {
    querySelector: (selector) => elements[selector],
    querySelectorAll: () => [],
    createElement: () => new Element()
  };

  const page = {
    elements,
    tick() {
      assert.equal(typeof intervalCallback, 'function', 'timer should be running');
      intervalCallback();
    },
    isRunning() {
      return intervalCallback !== null;
    }
  };

  vm.runInNewContext(script, {
    document,
    window,
    Date: FakeDate,
    fetch: (url, options) => fetch(new URL(url, baseUrl), options),
    console,
    Math,
    Map,
    Number,
    JSON,
    Promise,
    Blob,
    URL
  });

  return page;
}

async function waitForHistory(historyFile, predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const history = JSON.parse(await fs.readFile(historyFile, 'utf8'));
      if (predicate(history)) return history;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for memory.json to be updated.');
}

test('starting and completing a timer saves its end time and elapsed duration', async () => {
  await withTimerServer(async ({ baseUrl, historyFile }) => {
    const clock = { now: Date.parse('2026-01-01T10:00:00.000Z') };
    const page = createTimerPage(baseUrl, clock);
    await new Promise((resolve) => setTimeout(resolve, 20));

    page.elements['#duration'].value = '0:02';
    await page.elements['#run-button'].click();
    const startedHistory = await waitForHistory(historyFile, (history) => history.sessions.length === 1);
    const started = startedHistory.sessions[0];
    assert.equal(started.timestamp, '2026-01-01T10:00:00.000Z');
    assert.equal(started.timer, '2 sec');
    assert.equal(started.completed, false);
    assert.equal(started.endedAt, null);
    assert.equal(started.elapsedSeconds, null);

    clock.now += 2000;
    page.tick();
    assert.equal(page.isRunning(), false);
    const completedHistory = await waitForHistory(
      historyFile,
      (history) => history.sessions[0]?.completed === true
    );
    assert.deepEqual(completedHistory.sessions[0], {
      ...started,
      completed: true,
      endedAt: '2026-01-01T10:00:02.000Z',
      elapsedSeconds: 2
    });
  });
});

test('stopping after pause records only active elapsed seconds', async () => {
  await withTimerServer(async ({ baseUrl, historyFile }) => {
    const clock = { now: Date.parse('2026-01-01T10:00:00.000Z') };
    const page = createTimerPage(baseUrl, clock);
    await new Promise((resolve) => setTimeout(resolve, 20));

    page.elements['#duration'].value = '0:10';
    await page.elements['#run-button'].click();
    await waitForHistory(historyFile, (history) => history.sessions.length === 1);

    clock.now += 3200;
    page.tick();
    page.elements['#pause-button'].click();
    assert.equal(page.elements['#time-display'].textContent, '00:07');

    clock.now += 60_000;
    await page.elements['#run-button'].click();
    clock.now += 2500;
    page.elements['#stop-button'].click();

    const stoppedHistory = await waitForHistory(
      historyFile,
      (history) => history.sessions[0]?.endedAt !== null
    );
    assert.equal(stoppedHistory.sessions.length, 1);
    assert.equal(stoppedHistory.sessions[0].completed, false);
    assert.equal(stoppedHistory.sessions[0].elapsedSeconds, 5);
    assert.equal(stoppedHistory.sessions[0].endedAt, '2026-01-01T10:01:05.700Z');
  });
});

test('deadline-based countdown catches up when interval callbacks are delayed', async () => {
  await withTimerServer(async ({ baseUrl, historyFile }) => {
    const clock = { now: Date.parse('2026-01-01T10:00:00.000Z') };
    const page = createTimerPage(baseUrl, clock);
    await new Promise((resolve) => setTimeout(resolve, 20));

    page.elements['#duration'].value = '0:04';
    await page.elements['#run-button'].click();
    await waitForHistory(historyFile, (history) => history.sessions.length === 1);

    clock.now += 3200;
    page.tick();
    assert.equal(page.elements['#time-display'].textContent, '00:01');

    clock.now += 900;
    page.tick();
    assert.equal(page.elements['#time-display'].textContent, '00:00');
    assert.equal(page.isRunning(), false);

    const history = await waitForHistory(
      historyFile,
      (data) => data.sessions[0]?.completed === true
    );
    assert.equal(history.sessions[0].elapsedSeconds, 4);
  });
});

test('history API preserves older records and rejects invalid elapsed fields', async () => {
  await withTimerServer(async ({ baseUrl, historyFile }) => {
    await fs.writeFile(historyFile, JSON.stringify({
      version: 1,
      sessions: [{
        id: 'legacy-session',
        timestamp: '2025-01-01T00:00:00.000Z',
        timer: '1 min',
        timerSeconds: 60,
        completed: true
      }]
    }));

    const headers = { 'Content-Type': 'application/json' };
    const legacy = await fetch(`${baseUrl}/api/history`).then((response) => response.json());
    assert.equal(legacy.sessions[0].endedAt, null);
    assert.equal(legacy.sessions[0].elapsedSeconds, null);

    const invalid = await fetch(`${baseUrl}/api/history`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'invalid-session',
        timestamp: '2026-01-01T10:00:00.000Z',
        timer: '1 min',
        timerSeconds: 60,
        completed: false,
        endedAt: '2026-01-01T10:00:01.000Z',
        elapsedSeconds: 61
      })
    });
    assert.equal(invalid.status, 400);
  });
});
