const durationInput = document.querySelector('#duration');
const display = document.querySelector('#time-display');
const validationMessage = document.querySelector('#validation-message');
const audioStatus = document.querySelector('#audio-status');
const historyStatus = document.querySelector('#history-status');
const runButton = document.querySelector('#run-button');
const pauseButton = document.querySelector('#pause-button');
const stopButton = document.querySelector('#stop-button');
const exportHistoryButton = document.querySelector('#export-history-button');
const presetButtons = document.querySelectorAll('[data-duration]');

let remainingSeconds = 0;
let timerId = null;
let isPaused = false;
let isStarting = false;
let audioContext = null;
let targetEndTime = null;
let activeSegmentStartedAt = null;
let elapsedMilliseconds = 0;
let historySessions = [];
let historyLoaded = false;
let activeSession = null;
let historyWriteQueue = Promise.resolve();

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateDisplay() {
  display.textContent = formatTime(remainingSeconds);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  display.setAttribute('aria-label', `Time remaining: ${minutes} minutes ${seconds} seconds`);
}

function updateControls() {
  const isRunning = timerId !== null;
  runButton.disabled = isRunning || isStarting;
  pauseButton.disabled = !isRunning;
  stopButton.disabled = !isRunning && !isPaused;
  runButton.textContent = isPaused ? 'Resume' : 'Run';
  presetButtons.forEach((button) => {
    button.disabled = isRunning || isPaused || isStarting;
  });
}

function showValidation(message = '') {
  validationMessage.textContent = message;
  durationInput.setAttribute('aria-invalid', String(Boolean(message)));
}

function reportAudioError(error) {
  audioStatus.textContent = 'The completion buzzer could not be played. Check your browser audio settings.';
  console.error('Unable to play the timer completion buzzer.', error);
}

function prepareAudio() {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    audioStatus.textContent = 'Audio alerts are not supported in this browser; the timer will still run.';
    return;
  }

  try {
    if (audioContext === null) {
      audioContext = new AudioContextConstructor();
    }

    if (audioContext.state === 'suspended') {
      audioContext.resume()
        .then(() => { audioStatus.textContent = ''; })
        .catch(reportAudioError);
    } else {
      audioStatus.textContent = '';
    }
  } catch (error) {
    reportAudioError(error);
  }
}

function playBuzzer() {
  if (!audioContext) return;

  const scheduleBuzzer = () => {
    const startTime = audioContext.currentTime + 0.05;

    for (let beep = 0; beep < 3; beep += 1) {
      const toneStart = startTime + beep * 0.3;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(440, toneStart);
      gain.gain.setValueAtTime(0.0001, toneStart);
      gain.gain.exponentialRampToValueAtTime(0.16, toneStart + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, toneStart + 0.18);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(toneStart);
      oscillator.stop(toneStart + 0.19);
    }
  };

  try {
    if (audioContext.state === 'running') {
      scheduleBuzzer();
    } else {
      audioContext.resume().then(scheduleBuzzer).catch(reportAudioError);
    }
  } catch (error) {
    reportAudioError(error);
  }
}

function clearPresetSelection() {
  presetButtons.forEach((button) => button.setAttribute('aria-pressed', 'false'));
}

function parseDuration(value) {
  const match = value.trim().match(/^(\d+)(?::(\d{1,2}))?$/);
  if (!match) return null;

  const minutes = Number(match[1]);
  const seconds = match[2] === undefined ? 0 : Number(match[2]);
  const totalSeconds = minutes * 60 + seconds;

  return seconds < 60 && totalSeconds > 0 ? totalSeconds : null;
}

function getDurationInSeconds() {
  const duration = parseDuration(durationInput.value);
  if (duration === null) {
    showValidation('Enter minutes, or minutes and seconds (for example, 2:30).');
    durationInput.focus();
    return null;
  }

  showValidation();
  return duration;
}

function reportHistoryError(error) {
  historyStatus.textContent = `Timer history is not being saved: ${error.message || 'unknown error'}`;
  console.error('Unable to save timer history to memory.json.', error);
}

function mergeSession(session) {
  const index = historySessions.findIndex((savedSession) => savedSession.id === session.id);
  if (index === -1) {
    historySessions.push(session);
  } else {
    historySessions[index] = session;
  }
}

async function loadHistory() {
  const response = await fetch('/api/history');
  if (!response.ok) {
    throw new Error(`Local timer server returned ${response.status}.`);
  }

  const data = await response.json();
  if (!data || data.version !== 1 || !Array.isArray(data.sessions)) {
    throw new Error('memory.json has an unsupported format.');
  }

  historySessions = data.sessions;
  historyLoaded = true;
  historyStatus.textContent = `Connected to memory.json (${historySessions.length} timer${historySessions.length === 1 ? '' : 's'} saved).`;
}

async function ensureHistoryLoaded() {
  if (!historyLoaded) {
    await loadHistory();
  }
}

function saveSession(session) {
  mergeSession(session);
  const snapshot = { ...session };

  historyWriteQueue = historyWriteQueue.then(async () => {
    const response = await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Local timer server returned ${response.status}.`);
    }

    mergeSession(data.session);
    historyStatus.textContent = `Saved to memory.json (${historySessions.length} timer${historySessions.length === 1 ? '' : 's'}).`;
  }).catch(reportHistoryError);

  return historyWriteQueue;
}

function createSessionId() {
  if (window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatDurationForHistory(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} sec`;
  if (seconds === 0) return `${minutes} min`;
  return `${minutes} min ${seconds} sec`;
}

function recordTimerStart(duration) {
  activeSession = {
    id: createSessionId(),
    timestamp: new Date().toISOString(),
    timer: formatDurationForHistory(duration),
    timerSeconds: duration,
    completed: false,
    endedAt: null,
    elapsedSeconds: null
  };
  // Track active segments separately so paused time is not counted in elapsed time.
  elapsedMilliseconds = 0;
  activeSegmentStartedAt = Date.now();
  saveSession(activeSession);
}

function recordTimerEnd(completed) {
  if (!activeSession) return;
  activeSession.completed = completed;
  activeSession.endedAt = new Date().toISOString();
  activeSession.elapsedSeconds = completed
    ? activeSession.timerSeconds
    : Math.min(activeSession.timerSeconds, Math.floor(elapsedMilliseconds / 1000));
  const endedSession = activeSession;
  activeSession = null;
  saveSession(endedSession);
}

function downloadHistory() {
  try {
    const contents = JSON.stringify({ version: 1, sessions: historySessions }, null, 2);
    const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'memory.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    historyStatus.textContent = 'Timer history downloaded as memory.json.';
  } catch (error) {
    reportHistoryError(error);
  }
}

function completeTimer() {
  window.clearInterval(timerId);
  timerId = null;
  isPaused = false;
  targetEndTime = null;
  activeSegmentStartedAt = null;
  elapsedMilliseconds = 0;
  remainingSeconds = 0;
  recordTimerEnd(true);
  updateDisplay();
  updateControls();
  playBuzzer();
}

function tick() {
  // Use the deadline as the source of truth; interval callbacks can be delayed in background tabs.
  remainingSeconds = Math.max(0, Math.ceil((targetEndTime - Date.now()) / 1000));
  updateDisplay();

  if (remainingSeconds <= 0) {
    completeTimer();
  }
}

async function startTimer() {
  if (isStarting) return;

  let duration;
  if (!isPaused) {
    duration = getDurationInSeconds();
    if (duration === null) return;
    remainingSeconds = duration;
    updateDisplay();
  }

  prepareAudio();
  isStarting = true;
  updateControls();
  try {
    if (!isPaused) {
      try {
        await ensureHistoryLoaded();
      } catch (error) {
        reportHistoryError(new Error(`${error.message} Start the app with "node server.js" and open http://localhost:3000.`));
      }
      recordTimerStart(duration);
    } else {
      activeSegmentStartedAt = Date.now();
    }

    targetEndTime = Date.now() + remainingSeconds * 1000;
    isPaused = false;
    timerId = window.setInterval(tick, 250);
  } finally {
    isStarting = false;
    updateControls();
  }
}

function pauseTimer() {
  const now = Date.now();
  remainingSeconds = Math.max(0, Math.ceil((targetEndTime - now) / 1000));
  if (remainingSeconds <= 0) {
    completeTimer();
    return;
  }
  elapsedMilliseconds += now - activeSegmentStartedAt;
  targetEndTime = null;
  activeSegmentStartedAt = null;
  window.clearInterval(timerId);
  timerId = null;
  isPaused = true;
  updateDisplay();
  updateControls();
}

function stopTimer() {
  if (timerId !== null) {
    remainingSeconds = Math.max(0, Math.ceil((targetEndTime - Date.now()) / 1000));
    if (remainingSeconds <= 0) {
      completeTimer();
      return;
    }
    elapsedMilliseconds += Date.now() - activeSegmentStartedAt;
  }
  targetEndTime = null;
  activeSegmentStartedAt = null;
  window.clearInterval(timerId);
  timerId = null;
  isPaused = false;
  recordTimerEnd(false);
  const duration = getDurationInSeconds();
  remainingSeconds = duration ?? 0;
  elapsedMilliseconds = 0;
  updateDisplay();
  updateControls();
}

runButton.addEventListener('click', startTimer);
pauseButton.addEventListener('click', pauseTimer);
stopButton.addEventListener('click', stopTimer);
durationInput.addEventListener('input', () => {
  showValidation();
  clearPresetSelection();
  if (timerId === null && !isPaused) {
    remainingSeconds = parseDuration(durationInput.value) ?? 0;
    elapsedMilliseconds = 0;
    updateDisplay();
  }
});

presetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const duration = Number(button.dataset.duration);
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    durationInput.value = seconds
      ? `${minutes}:${String(seconds).padStart(2, '0')}`
      : String(minutes);
    showValidation();
    clearPresetSelection();
    button.setAttribute('aria-pressed', 'true');
    remainingSeconds = duration;
    updateDisplay();
  });
});

exportHistoryButton.addEventListener('click', downloadHistory);

loadHistory().catch((error) => {
  historyLoaded = false;
  reportHistoryError(new Error(`${error.message} Start the app with "node server.js" and open http://localhost:3000.`));
});

updateDisplay();
updateControls();
