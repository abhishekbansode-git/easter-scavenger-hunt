/**
 * Thin Frontend Client (v2):
 * Contains only UI state, step navigation, font switching, cached letter-limit
 * input guards, and async API calls to the protected Cloudflare Worker backend.
 * Zero mapping solver rules or cipher algorithms live in this file.
 */

const AppState = {
  selectedTheme: 1
};

const PrintState = {
  layout: 'portrait', // 'portrait' (1 per page) or 'landscape' (2 per page)
  paperSize: 'a4'     // 'a4' or 'letter'
};

let currentActiveStep = 1;
let currentPreviewClue = 1;
let cluePreviewMode = 'game'; // 'game' or 'answer'
let huntClues = [];
let hidingSpots = [];

let mappingDebounceTimer = null;
let livePreviewDebounceTimer = null;
let mappingRequestSeq = 0;
let previewRequestSeq = 0;
let activePrintPromise = null;
let backendSlotLimits = null;
const step2PreviewCache = new Map();
const printDocCache = new Map();

function invalidateAllContentCaches() {
  step2PreviewCache.clear();
  printDocCache.clear();
  if (typeof printWarmState !== 'undefined') {
    printWarmState.isWarmed = false;
  }
  activePrintPromise = null;
}

function getApiBaseUrl() {
  const raw = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || 'http://127.0.0.1:8787';
  return raw.replace(/\/+$/, '');
}

function getAssetBaseUrl() {
  return (window.APP_CONFIG && typeof window.APP_CONFIG.ASSET_BASE_URL === 'string')
    ? window.APP_CONFIG.ASSET_BASE_URL
    : '';
}

async function apiRequest(path, options = {}) {
  const url = `${getApiBaseUrl()}${path}`;
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined || (method !== 'GET' && method !== 'HEAD')) {
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(url, {
    ...options,
    method,
    headers
  });
  if (!res.ok) {
    let message = `API error (${res.status})`;
    try {
      const errBody = await res.json();
      if (errBody && errBody.error) message = errBody.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

function applyThemeFonts(themeId) {
  const isBaskerville = (themeId === 2 || themeId === 4);
  const headingFont = isBaskerville ? "var(--font-baskerville)" : "var(--font-franklin)";
  document.documentElement.style.setProperty("--clue-heading-font", headingFont);
  document.documentElement.style.setProperty("--clue-content-font", "var(--font-roboto)");
  const previewPaper = document.getElementById("clue-preview-card-paper");
  if (previewPaper) {
    previewPaper.classList.remove("theme-font-baskerville", "theme-font-franklin");
    previewPaper.classList.add(isBaskerville ? "theme-font-baskerville" : "theme-font-franklin");
  }
}

function selectTheme(themeId) {
  AppState.selectedTheme = themeId;
  applyThemeFonts(themeId);
  preloadThemeAssets(themeId);

  for (let i = 1; i <= 4; i++) {
    const chip = document.getElementById(`step3-theme-chip-${i}`);
    if (chip) chip.classList.toggle('active', i === themeId);
  }

  const labels = {
    1: 'Spring Pastel (Theme 1)',
    2: 'Watercolor Eggs (Theme 2)',
    3: 'Pastel Stripes (Theme 3)',
    4: 'Easter Variety Collection (Theme 4)'
  };
  const shortNames = {
    1: 'Design 1: Spring Pastel',
    2: 'Design 2: Watercolor Eggs',
    3: 'Design 3: Pastel Stripes',
    4: 'Design 4: Easter Variety'
  };

  const label = document.getElementById('selected-theme-label');
  if (label) label.textContent = labels[themeId] || labels[1];
  const step3Label = document.getElementById('step3-theme-name-tag');
  if (step3Label) step3Label.textContent = shortNames[themeId] || shortNames[1];
  const stageThemeBadge = document.getElementById('stage-theme-name');
  if (stageThemeBadge) stageThemeBadge.textContent = shortNames[themeId] || shortNames[1];

  if (currentActiveStep === 2) {
    if (livePreviewDebounceTimer) {
      clearTimeout(livePreviewDebounceTimer);
      livePreviewDebounceTimer = null;
    }
    renderCurrentCluePreview();
  }
  invalidatePrintWarmup();
}

let mappingToastTimer = null;
function showMappingToast(message, duration = 3200) {
  const toast = document.getElementById('mapping-toast');
  const text = document.getElementById('mapping-toast-text');
  if (!toast || !text) return;
  text.textContent = message;
  toast.style.display = 'flex';
  void toast.offsetWidth;
  toast.classList.add('visible');

  if (mappingToastTimer) clearTimeout(mappingToastTimer);
  mappingToastTimer = setTimeout(() => {
    hideMappingToast();
  }, duration);
}

function hideMappingToast() {
  const toast = document.getElementById('mapping-toast');
  if (!toast) return;
  toast.classList.remove('visible');
  if (mappingToastTimer) {
    clearTimeout(mappingToastTimer);
    mappingToastTimer = null;
  }
  setTimeout(() => {
    if (!toast.classList.contains('visible')) {
      toast.style.display = 'none';
    }
  }, 300);
}

function getActiveHuntClues() {
  if (!Array.isArray(huntClues) || huntClues.length === 0) return [];
  const step2El = document.getElementById('panel-step-2');
  const step3El = document.getElementById('panel-step-3');
  const inStep2Or3 = currentActiveStep >= 2 ||
    ((step2El && step2El.style.display !== 'none') ||
     (step3El && step3El.style.display !== 'none'));

  if (inStep2Or3) {
    return huntClues.filter(c => {
      if (c.disabled) return false;
      if (c.isStatic) return c.staticChecked !== false;
      return !!c.selectedForHunt;
    });
  }

  return huntClues.filter(c => {
    if (c.disabled) return false;
    if (c.isStatic) return c.staticChecked !== false;
    return (c.location || '').trim().length > 0;
  });
}

function getLetterCount(str) {
  if (!str) return 0;
  return str.replace(/[^a-zA-Z]/g, '').length;
}

function limitToMaxLetters(str, maxLetters) {
  if (!str) return '';
  let count = 0;
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (/[a-zA-Z]/.test(ch)) {
      if (count >= maxLetters) break;
      count++;
    }
    result += ch;
  }
  return result;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getCachedMaxCapForSpot(slotIndex) {
  if (typeof slotIndex !== 'number' || !huntClues[slotIndex] || huntClues[slotIndex].disabled) {
    return 15;
  }
  return huntClues[slotIndex].maxCap || huntClues[slotIndex].maxLen || 15;
}

function mergeBackendCluesPreservingFocused(backendClues, focusedIndex = -1) {
  if (!Array.isArray(backendClues)) return;
  const activeEl = document.activeElement;
  backendClues.forEach((srv, i) => {
    if (!huntClues[i]) {
      huntClues[i] = { ...srv };
      return;
    }
    const isFocusedStep1 = (i === focusedIndex) || (activeEl && activeEl.id === `spot-input-${i}`);
    const isFocusedStep2 = activeEl && activeEl.id === 'preview-clue-input';
    if (!isFocusedStep1 && !isFocusedStep2) {
      huntClues[i].location = srv.location;
    }
    huntClues[i].maxLen = srv.maxLen;
    huntClues[i].maxCap = srv.maxCap;
    huntClues[i].isStatic = srv.isStatic;
    huntClues[i].placeholder = srv.placeholder;
  });
}

function isFeasibleCapacityList(wordsLens, poolLens) {
  const wSorted = [...wordsLens].sort((a, b) => b - a);
  const pSorted = [...poolLens].sort((a, b) => b - a);
  if (wSorted.length > pSorted.length) return false;
  for (let i = 0; i < wSorted.length; i++) {
    if (pSorted[i] < wSorted[i]) return false;
  }
  return true;
}

function findMatchingStaticRule(availStatic, upperLoc) {
  if (!upperLoc || !Array.isArray(availStatic)) return -1;
  return availStatic.findIndex(rule => Array.isArray(rule.keys) && rule.keys.includes(upperLoc));
}

/**
 * Mirrors backend capacity & static-slot matching locally in Step 1 using
 * only the plain limit numbers/keywords returned by /api/init (0 API calls).
 */
function recomputeLocalStep1Capacities(focusedIndex = -1) {
  if (!backendSlotLimits || !Array.isArray(huntClues) || !huntClues.length) return;

  const activeClues = huntClues.filter(c => !c.disabled);
  if (!activeClues.length) return;

  const availDynamic = [...(backendSlotLimits.dynamicPool || [])].sort((a, b) => a - b);
  const availStatic = (backendSlotLimits.staticRules || []).map(r => ({
    keys: r.keys || [],
    maxLen: r.maxLen || 15
  }));
  const assigned = new Map();

  // Pass 1: exact static location match
  activeClues.forEach(c => {
    const cleanLoc = (c.location || '').trim().toUpperCase();
    if (!cleanLoc) return;
    const sIdx = findMatchingStaticRule(availStatic, cleanLoc);
    if (sIdx !== -1) {
      assigned.set(c, { maxLen: availStatic[sIdx].maxLen, isStatic: true });
      c.isStatic = true;
      availStatic.splice(sIdx, 1);
    } else {
      c.isStatic = false;
    }
  });

  // Pass 2: assign remaining dynamic slots shortest -> longest
  const wordsInfo = [];
  activeClues.forEach(c => {
    if (assigned.has(c)) return;
    const wlen = getLetterCount(c.location);
    if (wlen > 0) {
      wordsInfo.push({ clue: c, len: wlen, origIndex: huntClues.indexOf(c) });
    }
  });
  wordsInfo.sort((a, b) => a.len - b.len || a.origIndex - b.origIndex);

  wordsInfo.forEach(item => {
    if (!availDynamic.length) return;
    let chosenIdx = availDynamic.findIndex(cap => cap >= item.len);
    if (chosenIdx === -1) chosenIdx = availDynamic.length - 1;
    assigned.set(item.clue, { maxLen: availDynamic[chosenIdx], isStatic: false });
    availDynamic.splice(chosenIdx, 1);
  });

  // Pass 3: empty slots take remaining dynamic (or static fallback)
  activeClues.forEach(c => {
    if (assigned.has(c)) return;
    if (availDynamic.length > 0) {
      assigned.set(c, { maxLen: availDynamic.shift(), isStatic: false });
    } else if (availStatic.length > 0) {
      const sp = availStatic.shift();
      assigned.set(c, { maxLen: sp.maxLen, isStatic: true });
    }
  });

  activeClues.forEach(c => {
    const info = assigned.get(c);
    if (info) {
      c.maxLen = info.maxLen;
      c.isStatic = !!info.isStatic;
    }
  });

  // Compute remaining maxCap for each slot matching backend getMaxAvailableCapacityForSpot
  const sortedPool = [...(backendSlotLimits.dynamicPool || [])].sort((a, b) => b - a);
  huntClues.forEach((c, slotIndex) => {
    if (c.disabled) {
      c.maxCap = c.maxLen || 15;
      return;
    }
    const cleanLoc = (c.location || '').trim().toUpperCase();
    const staticRule = (backendSlotLimits.staticRules || []).find(r => r.keys && r.keys.includes(cleanLoc));
    if (staticRule) {
      c.maxCap = staticRule.maxLen;
      return;
    }

    const otherWords = [];
    activeClues.forEach(other => {
      if (huntClues.indexOf(other) === slotIndex) return;
      const loc = (other.location || '').trim();
      if (!loc) return;
      const up = loc.toUpperCase();
      if ((backendSlotLimits.staticRules || []).some(r => r.keys && r.keys.includes(up))) return;
      const ll = getLetterCount(loc);
      if (ll > 0) otherWords.push(ll);
    });

    let computedMaxCap = 15;
    for (let i = 0; i < sortedPool.length; i++) {
      const candLen = sortedPool[i];
      const poolAfter = [...(backendSlotLimits.dynamicPool || [])];
      const remIdx = poolAfter.indexOf(candLen);
      if (remIdx !== -1) poolAfter.splice(remIdx, 1);
      if (isFeasibleCapacityList(otherWords, poolAfter)) {
        computedMaxCap = candLen;
        break;
      }
    }
    c.maxCap = computedMaxCap;
    if (slotIndex !== focusedIndex && !c.isStatic && getLetterCount(c.location) > c.maxCap) {
      c.location = limitToMaxLetters(c.location, c.maxCap);
    }
  });
}

async function syncMappingWithBackend(focusedIndex = -1) {
  if (backendSlotLimits) {
    recomputeLocalStep1Capacities(focusedIndex);
    updateSpotsListDOMInPlace(focusedIndex);
    syncHidingSpots();
    return;
  }
  const reqId = ++mappingRequestSeq;
  try {
    const data = await apiRequest('/api/map-and-preview', {
      method: 'POST',
      body: JSON.stringify({
        clues: huntClues,
        inStep2Or3: currentActiveStep >= 2,
        includePreview: false,
        themeId: AppState.selectedTheme,
        assetBaseUrl: getAssetBaseUrl()
      })
    });
    if (reqId !== mappingRequestSeq) return;
    mergeBackendCluesPreservingFocused(data.clues, focusedIndex);
    updateSpotsListDOMInPlace(focusedIndex);
    syncHidingSpots();
  } catch (err) {
    console.warn('Backend mapping sync warning:', err);
  }
}

function scheduleMappingSync(focusedIndex = -1, delayMs = 220) {
  if (backendSlotLimits) {
    recomputeLocalStep1Capacities(focusedIndex);
    updateSpotsListDOMInPlace(focusedIndex);
    return;
  }
  if (mappingDebounceTimer) clearTimeout(mappingDebounceTimer);
  mappingDebounceTimer = setTimeout(() => {
    syncMappingWithBackend(focusedIndex);
  }, delayMs);
}

function updateSpotsListDOMInPlace(focusedIndex = -1) {
  let slotNumber = 0;
  huntClues.forEach((item, i) => {
    const card = document.getElementById(`spot-card-${i}`);
    const badge = document.getElementById(`spot-badge-${i}`);
    const input = document.getElementById(`spot-input-${i}`);
    if (!card) return;

    const isNotExplicitlyDisabled = !item.disabled;
    const hasText = (item.location || '').trim().length > 0;
    const isActiveInHunt = isNotExplicitlyDisabled && hasText;

    if (isActiveInHunt) slotNumber++;

    if (!isNotExplicitlyDisabled) {
      card.classList.add('is-disabled');
      card.classList.remove('is-dimmed');
      if (badge) badge.textContent = `Clue #${i + 1}`;
    } else if (!hasText) {
      card.classList.remove('is-disabled');
      card.classList.add('is-dimmed');
      if (badge) badge.textContent = 'Clue —';
    } else {
      card.classList.remove('is-disabled');
      card.classList.remove('is-dimmed');
      if (badge) badge.textContent = `Clue #${slotNumber}`;
    }

    const maxCap = isNotExplicitlyDisabled ? getCachedMaxCapForSpot(i) : (item.maxLen || 15);
    if (input) {
      input.maxLength = maxCap + 8;
      if (i !== focusedIndex) {
        input.placeholder = item.placeholder || `Location #${i + 1}`;
      }
    }
  });
}

function syncHidingSpots() {
  const active = getActiveHuntClues();
  hidingSpots = active.map(c => c.location);
  const count = active.length;
  const countEl = document.getElementById('spots-count');
  if (countEl) countEl.textContent = count;
  const subCount = document.getElementById('subheading-spots-count');
  if (subCount) {
    subCount.textContent = (count === huntClues.length) ? `${count}` : `${count} of ${huntClues.length}`;
  }
  const plural = document.getElementById('spots-plural');
  if (plural) plural.textContent = count === 1 ? '' : 's';
  updateStep3SheetCounts();
  invalidatePrintWarmup();
}

async function resetDefaultSpots() {
  if (!confirm('Reset back to the default clues and hiding spots?')) return;
  try {
    const data = await apiRequest('/api/init');
    huntClues = Array.isArray(data.clues) ? data.clues : [];
    if (data.slotLimits) backendSlotLimits = data.slotLimits;
    invalidateAllContentCaches();
    syncHidingSpots();
    renderSpotsList();
    currentPreviewClue = 1;
    updateStep3SheetCounts();
    if (currentActiveStep === 2) {
      renderCurrentCluePreview();
    }
  } catch (err) {
    showMappingToast(`Could not reach backend API: ${err.message}`);
  }
}

function clearAllSpots() {
  if (!confirm('Clear all hiding spots to start blank?')) return;
  huntClues.forEach((item, i) => {
    item.location = '';
    item.placeholder = `Location #${i + 1}`;
    item.selectedForHunt = false;
  });
  invalidateAllContentCaches();
  recomputeLocalStep1Capacities(-1);
  syncHidingSpots();
  renderSpotsList();
  currentPreviewClue = 1;
  updateStep3SheetCounts();
  scheduleMappingSync(-1, 50);
  if (currentActiveStep === 2) {
    renderCurrentCluePreview();
  }
  const firstInput = document.getElementById('spot-input-0');
  if (firstInput) firstInput.focus();
}

function getMaxLocationLength(clueNum) {
  const active = getActiveHuntClues();
  const item = (active && active[clueNum - 1]) || huntClues[clueNum - 1];
  return item ? (item.maxLen || 15) : 15;
}

const limitNoticeTimers = new Map();

function showLimitNoticeTemporarily(badge, input, maxLen, duration = 1800) {
  if (!badge) return;
  badge.textContent = `Max ${maxLen} letters reached`;
  badge.classList.add('visible');
  if (input) input.classList.add('input-at-max');

  if (limitNoticeTimers.has(badge)) {
    clearTimeout(limitNoticeTimers.get(badge));
  }

  const timer = setTimeout(() => {
    badge.classList.remove('visible');
    if (input) input.classList.remove('input-at-max');
    limitNoticeTimers.delete(badge);
  }, duration);

  limitNoticeTimers.set(badge, timer);
}

function hideLimitNotice(badge, input) {
  if (!badge) return;
  if (limitNoticeTimers.has(badge)) {
    clearTimeout(limitNoticeTimers.get(badge));
    limitNoticeTimers.delete(badge);
  }
  badge.classList.remove('visible');
  if (input) input.classList.remove('input-at-max');
}

function handleLocationKeydown(e, maxLen, arg3, arg4) {
  let badgeEl = null;
  let slotIndex = null;
  let isStep2 = false;

  if (typeof arg3 === 'number') {
    slotIndex = arg3;
  } else if (arg3 && arg3.nodeType) {
    badgeEl = arg3;
    if (typeof arg4 === 'number') {
      slotIndex = arg4;
    } else {
      isStep2 = true;
    }
  }

  if (!e.key || e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }

  if (/^[0-9]$/.test(e.key)) {
    e.preventDefault();
    showMappingToast("Numbers are not allowed in hiding spots. Use letters only.");
    return;
  }

  if (e.key.length !== 1 || e.key === ' ' || !/^[a-zA-Z]$/.test(e.key)) {
    return;
  }

  const currentVal = e.target.value || '';
  const selStart = e.target.selectionStart || 0;
  const selEnd = e.target.selectionEnd || 0;
  const maxCap = isStep2 ? maxLen : ((typeof slotIndex === 'number') ? getCachedMaxCapForSpot(slotIndex) : maxLen);

  const selectedText = currentVal.substring(selStart, selEnd);
  const selectedLetters = getLetterCount(selectedText);
  const currentLetters = getLetterCount(currentVal);
  const lettersAfterKey = currentLetters - selectedLetters + 1;

  if (lettersAfterKey > maxCap) {
    e.preventDefault();
    if (badgeEl) {
      showLimitNoticeTemporarily(badgeEl, e.target, maxCap, 1800);
      badgeEl.classList.remove('limit-shake');
      void badgeEl.offsetWidth;
      badgeEl.classList.add('limit-shake');
      setTimeout(() => badgeEl.classList.remove('limit-shake'), 280);
    }
    if (!isStep2) {
      if (maxCap < 15) {
        showMappingToast(`All longer clue slots are in use. Maximum length available is ${maxCap} letters.`);
      } else {
        showMappingToast("Maximum clue length is 15 letters.");
      }
    }
  }
}

function renderSpotsList() {
  const list = document.getElementById('spots-list');
  const count = document.getElementById('spots-count');
  const plural = document.getElementById('spots-plural');
  const activeClues = getActiveHuntClues();
  if (count) count.textContent = activeClues.length;
  if (plural) plural.textContent = activeClues.length === 1 ? '' : 's';

  if (!list) return;

  if (!huntClues.length) {
    list.innerHTML = `<div style="padding: 20px; color: #64748b;">Connecting to backend API...</div>`;
    return;
  }

  let slotNumber = 0;
  list.innerHTML = huntClues.map((item, i) => {
    const isDisabled = !!item.disabled;
    const maxCap = getCachedMaxCapForSpot(i);
    const hasText = (item.location || '').trim().length > 0;
    const isActiveInHunt = !isDisabled && hasText;

    if (isActiveInHunt) slotNumber++;
    const clueBadgeText = isActiveInHunt ? `Clue #${slotNumber}` : (isDisabled ? `Clue #${i + 1}` : 'Clue —');

    let cardClass = '';
    if (isDisabled) cardClass = 'is-disabled';
    else if (!hasText) cardClass = 'is-dimmed';

    return `
      <div
        class="spot-card ${cardClass}"
        id="spot-card-${i}"
        ${isDisabled ? '' : 'draggable="true"'}
        ondragstart="handleDragStart(event, ${i})"
        ondragover="handleDragOver(event)"
        ondragleave="handleDragLeave(event)"
        ondrop="handleDrop(event, ${i})"
        ondragend="handleDragEnd(event)"
      >
        <div class="spot-drag-handle" title="Drag to reorder">⠿</div>
        <div class="spot-meta-col">
          <div class="spot-badge" id="spot-badge-${i}">${clueBadgeText}</div>
        </div>
        <div class="spot-input-wrap">
          <input
            type="text"
            class="spot-input"
            id="spot-input-${i}"
            maxlength="${maxCap + 8}"
            placeholder="${escapeHtml(item.placeholder || `Location #${i + 1}`)}"
            value="${escapeHtml(item.location)}"
            ${isDisabled ? 'readonly' : ''}
            ${isDisabled ? '' : `oninput="updateSpot(${i}, this.value)" onkeydown="handleLocationKeydown(event, ${maxCap}, ${i})"`}
          >
        </div>
        <div class="spot-actions">
          <button
            type="button"
            class="spot-btn spot-btn-up"
            title="Move Up"
            onclick="moveSpot(${i}, -1)"
            ${(isDisabled || i === 0) ? 'disabled' : ''}
          >▲</button>
          <button
            type="button"
            class="spot-btn spot-btn-down"
            title="Move Down"
            onclick="moveSpot(${i}, 1)"
            ${(isDisabled || i === huntClues.length - 1) ? 'disabled' : ''}
          >▼</button>
          <button
            type="button"
            class="spot-btn spot-btn-delete"
            title="Clear location"
            onclick="clearSpotLocation(${i})"
            ${isDisabled ? 'disabled' : ''}
          >✕</button>
        </div>
      </div>
    `;
  }).join('');
}

function clearSpotLocation(index) {
  if (!huntClues[index]) return;
  huntClues[index].location = '';
  invalidateAllContentCaches();
  recomputeLocalStep1Capacities(-1);
  syncHidingSpots();
  renderSpotsList();
  scheduleMappingSync(-1, 50);
  const el = document.getElementById(`spot-input-${index}`);
  if (el) el.focus();
}

function toggleClueDisabled(index) {
  clearSpotLocation(index);
}

function updateStep1ColumnWidth() {}
function scrollStep1Clues() {}
function updateStep1ScrollArrows() {}

function updateSpot(index, value) {
  const item = huntClues[index];
  if (!item) return;

  value = (value || '').replace(/[0-9]/g, '');

  const maxCap = getCachedMaxCapForSpot(index);
  const input = document.getElementById(`spot-input-${index}`);

  let wasTruncated = false;
  const letters = getLetterCount(value);
  if (letters > maxCap) {
    value = limitToMaxLetters(value, maxCap);
    if (input) input.value = value;
    wasTruncated = true;
  }

  item.location = value;
  invalidateAllContentCaches();
  recomputeLocalStep1Capacities(index);
  updateSpotsListDOMInPlace(index);
  syncHidingSpots();

  if (wasTruncated) {
    if (maxCap < 15) {
      showMappingToast(`All longer clue slots are in use. Maximum length available is ${maxCap} letters.`);
    } else {
      showMappingToast("Maximum clue length is 15 letters.");
    }
  }

  scheduleMappingSync(index, 220);

  if (currentActiveStep === 2) {
    scheduleLivePreviewRender(550);
  }
}

function moveSpot(index, delta) {
  if (huntClues[index] && huntClues[index].disabled) return;
  const target = index + delta;
  if (target < 0 || target >= huntClues.length || (huntClues[target] && huntClues[target].disabled)) return;
  const item = huntClues.splice(index, 1)[0];
  huntClues.splice(target, 0, item);
  invalidateAllContentCaches();
  recomputeLocalStep1Capacities(-1);
  syncHidingSpots();
  renderSpotsList();
  scheduleMappingSync(-1, 50);
  const el = document.getElementById(`spot-card-${target}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let draggedIndex = null;
function handleDragStart(e, index) {
  draggedIndex = index;
  e.dataTransfer.effectAllowed = 'move';
  const card = document.getElementById(`spot-card-${index}`);
  if (card) card.classList.add('dragging');
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const card = e.currentTarget.closest('.spot-card');
  if (card) card.classList.add('drag-over');
}

function handleDragLeave(e) {
  const card = e.currentTarget.closest('.spot-card');
  if (card) card.classList.remove('drag-over');
}

function handleDrop(e, targetIndex) {
  e.preventDefault();
  const card = e.currentTarget.closest('.spot-card');
  if (card) card.classList.remove('drag-over');
  if (draggedIndex === null || draggedIndex === targetIndex) return;
  const enabledClues = huntClues.filter(c => !c.disabled);
  if (targetIndex >= enabledClues.length || draggedIndex >= enabledClues.length) return;
  const item = huntClues.splice(draggedIndex, 1)[0];
  huntClues.splice(targetIndex, 0, item);
  draggedIndex = null;
  invalidateAllContentCaches();
  recomputeLocalStep1Capacities(-1);
  syncHidingSpots();
  renderSpotsList();
  scheduleMappingSync(-1, 50);
}

function handleDragEnd() {
  draggedIndex = null;
  document.querySelectorAll('.spot-card').forEach(c => {
    c.classList.remove('dragging', 'drag-over');
  });
}

function updateStep3SheetCounts() {
  const activeClues = getActiveHuntClues();
  const count = (activeClues.length > 0 ? activeClues.length : 1) + 2;
  const halfCount = Math.ceil(count / 2);
  const portCountEl = document.getElementById('sheet-count-portrait');
  const landCountEl = document.getElementById('sheet-count-landscape');
  if (portCountEl) portCountEl.textContent = `${count} Sheets`;
  if (landCountEl) landCountEl.textContent = `${halfCount} Sheets`;
}

function navigateToStep(stepNum) {
  currentActiveStep = stepNum;
  document.querySelectorAll('.step-panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById(`panel-step-${stepNum}`);
  if (panel) panel.style.display = '';

  if (stepNum === 1) {
    renderSpotsList();
  }
  if (stepNum === 2) {
    switchCluePreview(currentPreviewClue);
    setTimeout(updateClueStageScale, 50);
    setTimeout(updateClueStageScale, 200);
  }
  if (stepNum === 3) {
    updateStep3SheetCounts();
  }

  document.querySelectorAll('.step-item').forEach((el, i) => {
    const num = i + 1;
    el.classList.remove('active', 'completed');
    if (num < stepNum) el.classList.add('completed');
    else if (num === stepNum) el.classList.add('active');
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function getStep2CacheKey(themeId = AppState.selectedTheme, mode = cluePreviewMode) {
  return `${themeId || 1}:${mode || 'game'}`;
}

function storeStep2BatchPreviews(themeId, mode, previews) {
  if (!Array.isArray(previews)) return;
  const map = new Map();
  previews.forEach(item => {
    if (item && typeof item.clueNum === 'number') {
      map.set(item.clueNum, item);
    }
  });
  step2PreviewCache.set(getStep2CacheKey(themeId, mode), map);
}

async function proceedToStep2() {
  const validClues = huntClues.filter(c => {
    if (c.disabled) return false;
    if (c.isStatic) return c.staticChecked !== false;
    return (c.location || '').trim().length > 0;
  });

  if (validClues.length === 0) {
    alert('Please enter at least one hiding spot location!');
    const firstInput = document.getElementById('spot-input-0');
    if (firstInput) firstInput.focus();
    return;
  }

  huntClues.forEach(c => {
    c.selectedForHunt = validClues.includes(c);
  });

  if (currentPreviewClue > validClues.length) {
    currentPreviewClue = 1;
  }

  if (mappingDebounceTimer) {
    clearTimeout(mappingDebounceTimer);
    mappingDebounceTimer = null;
  }

  const targetTheme = AppState.selectedTheme || 1;
  const targetMode = cluePreviewMode || 'game';
  if (!step2PreviewCache.has(getStep2CacheKey(targetTheme, targetMode))) {
    try {
      const data = await apiRequest('/api/map-and-preview', {
        method: 'POST',
        body: JSON.stringify({
          clues: huntClues,
          inStep2Or3: true,
          includeBatchPreview: true,
          previewClueNum: currentPreviewClue,
          themeId: targetTheme,
          mode: targetMode,
          assetBaseUrl: getAssetBaseUrl()
        })
      });
      mergeBackendCluesPreservingFocused(data.clues, -1);
      storeStep2BatchPreviews(targetTheme, targetMode, data.previews);
    } catch (err) {
      showMappingToast(`Backend API error: ${err.message}`);
    }
  }

  navigateToStep(2);
}

function goBackToStep1() {
  navigateToStep(1);
}

function proceedToStep3() {
  const validClues = huntClues.filter(c => {
    if (c.disabled) return false;
    if (c.isStatic) return c.staticChecked !== false;
    return (c.location || '').trim().length > 0;
  });
  huntClues.forEach(c => {
    c.selectedForHunt = validClues.includes(c);
  });

  const activeClues = getActiveHuntClues();
  const emptyIdx = activeClues.findIndex(c => !c.isStatic && !(c.location || '').trim());
  if (emptyIdx !== -1) {
    const clueNum = emptyIdx + 1;
    alert(`Please enter an answer for Clue ${clueNum} before proceeding to download.`);
    navigateToStep(2);
    switchCluePreview(clueNum);
    const input = document.getElementById('preview-clue-input');
    if (input) {
      input.focus();
      input.select();
    }
    return;
  }
  navigateToStep(3);
}

function goBackToStep2() {
  navigateToStep(2);
}

function getTotalCluesCount() {
  const active = getActiveHuntClues();
  return (active && active.length > 0) ? active.length : 1;
}

function navigateCluePreview(delta) {
  const total = getTotalCluesCount();
  let next = currentPreviewClue + delta;
  if (next < 1) next = total;
  if (next > total) next = 1;
  switchCluePreview(next);
}

function switchCluePreview(clueNum) {
  if (livePreviewDebounceTimer) {
    clearTimeout(livePreviewDebounceTimer);
    livePreviewDebounceTimer = null;
  }
  const total = getTotalCluesCount();
  if (clueNum < 1) clueNum = 1;
  if (clueNum > total) clueNum = total;
  currentPreviewClue = clueNum;

  const titleEl = document.getElementById('clue-stepper-title');
  if (titleEl) {
    titleEl.textContent = `Clue ${clueNum} of ${total}`;
  }

  const idx = clueNum - 1;
  const activeClues = getActiveHuntClues();
  const item = activeClues[idx];
  const isStatic = !!(item && item.isStatic);

  const label = document.getElementById('preview-clue-label');
  const input = document.getElementById('preview-clue-input');
  const locVal = (item && typeof item.location === 'string') ? item.location : '';
  const placeholderVal = item
    ? (item.placeholder ? item.placeholder.replace('e.g. ', '') : `Location #${clueNum}`)
    : `Location #${clueNum}`;

  const maxLen = item ? (item.maxLen || 15) : 15;
  if (input) {
    input.maxLength = maxLen + 8;
    input.value = locVal;
    input.placeholder = placeholderVal;
    input.disabled = isStatic;
    if (isStatic) {
      input.classList.add('is-static-locked');
      input.title = "Go back to hiding spots step to edit";
    } else {
      input.classList.remove('is-static-locked');
      input.title = "";
    }
  }
  if (label) {
    label.textContent = isStatic ? `Answer #${clueNum} (Go back to hiding spots step to edit):` : `Answer #${clueNum}:`;
  }
  hideLimitNotice(document.getElementById('preview-clue-limit-badge'), input);

  const charBadge = document.getElementById('preview-clue-char-count');
  if (charBadge) {
    const letters = getLetterCount(locVal);
    charBadge.textContent = `${letters} / ${maxLen} letters`;
    charBadge.classList.toggle('warning', letters >= maxLen && letters > 0);
  }

  renderCurrentCluePreview();
  updateClueStageScale();
}

function updateClueStageScale() {
  const paper = document.getElementById('clue-preview-card-paper');
  const wrap = document.getElementById('clue-card-stage-wrap');
  const step2 = document.getElementById('panel-step-2');
  const stage = document.querySelector('.step3-card-column');
  const mat = document.querySelector('.step3-studio-mat');
  if (!paper || !step2 || step2.style.display === 'none' || !stage) return;

  const baseCardW = 480;
  const baseCardH = 480 * (3508 / 2480);

  let finalScale = 1.0;

  if (window.innerWidth <= 960) {
    const matEl = mat || stage;
    const containerW = matEl.clientWidth || (window.innerWidth - 24);
    const availMobileW = Math.max(260, containerW - 16);
    finalScale = Math.min(availMobileW / baseCardW, 1.0);
  } else {
    const matEl = mat || stage;
    const rect = matEl.getBoundingClientRect();
    const availH = Math.max(260, window.innerHeight - rect.top - 44);
    const innerAvailH = Math.max(240, availH - 32);
    const heightScale = innerAvailH / baseCardH;

    const availW = Math.max(300, (matEl.clientWidth || stage.clientWidth) - 40);
    const widthScale = availW / baseCardW;

    finalScale = Math.max(0.55, Math.min(widthScale, heightScale, 1.45));
  }

  paper.style.transform = `scale(${finalScale.toFixed(4)})`;
  paper.style.transformOrigin = 'top left';
  paper.style.zoom = '1';

  if (wrap) {
    wrap.style.width = `${(baseCardW * finalScale).toFixed(1)}px`;
    wrap.style.height = `${(baseCardH * finalScale).toFixed(1)}px`;
  }
}

let appResizeRafId = null;
function handleAppResize() {
  if (appResizeRafId) cancelAnimationFrame(appResizeRafId);
  appResizeRafId = requestAnimationFrame(() => {
    if (currentActiveStep === 2) {
      updateClueStageScale();
    }
  });
}

window.addEventListener('resize', handleAppResize, { passive: true });
window.addEventListener('orientationchange', () => {
  setTimeout(handleAppResize, 150);
});

window.addEventListener('keydown', (e) => {
  const step2 = document.getElementById('panel-step-2');
  if (step2 && step2.style.display !== 'none') {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      navigateCluePreview(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      navigateCluePreview(1);
    }
  }
});

function setCluePreviewMode(mode) {
  if (livePreviewDebounceTimer) {
    clearTimeout(livePreviewDebounceTimer);
    livePreviewDebounceTimer = null;
  }
  cluePreviewMode = mode;
  const btnGame = document.getElementById('btn-mode-game');
  const btnAns = document.getElementById('btn-mode-answer');
  if (btnGame) btnGame.classList.toggle('active', mode === 'game');
  if (btnAns) btnAns.classList.toggle('active', mode === 'answer');
  renderCurrentCluePreview();
}

function handleLiveSpotInput(val) {
  val = (val || '').replace(/[0-9]/g, '');
  const idx = currentPreviewClue - 1;
  const activeClues = getActiveHuntClues();
  const item = activeClues[idx] || huntClues[idx];
  if (item && item.isStatic) return;

  const maxLen = item ? (item.maxLen || 15) : 15;
  let wasTruncated = false;
  const letters = getLetterCount(val);
  if (letters > maxLen) {
    val = limitToMaxLetters(val, maxLen);
    const input = document.getElementById('preview-clue-input');
    if (input) input.value = val;
    wasTruncated = true;
  }

  if (item) {
    item.location = val;
    const huntIdx = huntClues.indexOf(item);
    if (huntIdx !== -1) {
      const step1Input = document.getElementById(`spot-input-${huntIdx}`);
      if (step1Input) step1Input.value = val;
    }
  }
  invalidateAllContentCaches();
  recomputeLocalStep1Capacities(-1);
  syncHidingSpots();
  updatePreviewLimitNotice(val, maxLen, wasTruncated);

  const charBadge = document.getElementById('preview-clue-char-count');
  if (charBadge) {
    const curLetters = getLetterCount(val);
    charBadge.textContent = `${curLetters} / ${maxLen} letters`;
    charBadge.classList.toggle('warning', curLetters >= maxLen);
  }
  scheduleLivePreviewRender(550);
}

function updatePreviewLimitNotice(val, maxLen, wasTruncated = false) {
  const badge = document.getElementById('preview-clue-limit-badge');
  const input = document.getElementById('preview-clue-input');
  if (!badge) return;
  if (wasTruncated) {
    showLimitNoticeTemporarily(badge, input, maxLen, 1800);
  } else if (val && getLetterCount(val) < maxLen) {
    hideLimitNotice(badge, input);
  }
}

function scheduleLivePreviewRender(delayMs = 550) {
  if (livePreviewDebounceTimer) clearTimeout(livePreviewDebounceTimer);
  livePreviewDebounceTimer = setTimeout(() => {
    livePreviewDebounceTimer = null;
    renderCurrentCluePreview();
  }, delayMs);
}

async function renderCurrentCluePreview() {
  const borderContainer = document.getElementById('clue-preview-border-container');
  const root = document.getElementById('clue-preview-content-root');
  if (!root) return;

  const targetTheme = AppState.selectedTheme || 1;
  const targetMode = cluePreviewMode || 'game';
  const cacheKey = getStep2CacheKey(targetTheme, targetMode);
  const cachedMap = !livePreviewDebounceTimer ? step2PreviewCache.get(cacheKey) : null;
  const cached = cachedMap ? cachedMap.get(currentPreviewClue) : null;

  if (cached) {
    if (borderContainer) {
      borderContainer.innerHTML = cached.borderHtml || '';
    }
    root.innerHTML = cached.cardHtml || '';
    return;
  }

  const reqId = ++previewRequestSeq;
  try {
    const data = await apiRequest('/api/map-and-preview', {
      method: 'POST',
      body: JSON.stringify({
        clues: huntClues,
        inStep2Or3: true,
        includeBatchPreview: true,
        previewClueNum: currentPreviewClue,
        themeId: targetTheme,
        mode: targetMode,
        assetBaseUrl: getAssetBaseUrl()
      })
    });
    if (reqId !== previewRequestSeq) return;

    mergeBackendCluesPreservingFocused(data.clues, -1);
    storeStep2BatchPreviews(targetTheme, targetMode, data.previews);

    const rendered = (Array.isArray(data.previews)
      ? data.previews.find(p => p.clueNum === currentPreviewClue)
      : null) || data.preview;

    if (rendered) {
      if (borderContainer) {
        borderContainer.innerHTML = rendered.borderHtml || '';
      }
      root.innerHTML = rendered.cardHtml || '';
    }
  } catch (err) {
    if (reqId !== previewRequestSeq) return;
    root.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:center; height:100%; padding:32px; text-align:center; color:#64748b; font-family:Roboto, sans-serif;">
        Unable to load card preview from API.<br>${escapeHtml(err.message)}
      </div>
    `;
  }
}

function selectPaperSize(size) {
  PrintState.paperSize = size;
  const btnA4 = document.getElementById('paper-btn-a4');
  const btnLetter = document.getElementById('paper-btn-letter');
  if (btnA4) btnA4.classList.toggle('active', size === 'a4');
  if (btnLetter) btnLetter.classList.toggle('active', size === 'letter');
  updatePrintPageStyle();
}

function selectPrintLayout(layout) {
  PrintState.layout = layout;
  const portCard = document.getElementById('layout-card-portrait');
  const landCard = document.getElementById('layout-card-landscape');
  const portInd = document.getElementById('layout-indicator-portrait');
  const landInd = document.getElementById('layout-indicator-landscape');

  if (portCard) portCard.classList.toggle('selected', layout === 'portrait');
  if (landCard) landCard.classList.toggle('selected', layout === 'landscape');
  if (portInd) portInd.textContent = (layout === 'portrait') ? '✓ Selected' : 'Select';
  if (landInd) landInd.textContent = (layout === 'landscape') ? '✓ Selected' : 'Select';
  updatePrintPageStyle();
}

function updatePrintPageStyle() {
  let styleEl = document.getElementById('dynamic-print-page');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'dynamic-print-page';
    document.head.appendChild(styleEl);
  }
  const orientation = PrintState.layout || 'portrait';
  const paper = (PrintState.paperSize === 'letter') ? 'letter' : 'a4';
  styleEl.textContent = `@page { size: ${paper} ${orientation}; margin: 0mm; }`;
}

let printWarmState = {
  isWarmed: false,
  mode: null,
  layout: null,
  paper: null,
  theme: null,
  cluesCount: 0
};

function invalidatePrintWarmup() {
  printWarmState.isWarmed = false;
  activePrintPromise = null;
  const step3 = document.getElementById('panel-step-3');
  if (!step3 || step3.style.display === 'none') {
    const root = document.getElementById('print-sheet-root');
    if (root) root.innerHTML = '';
  }
}

async function waitForPrintImages(root) {
  if (!root) return;
  const imgs = Array.from(root.querySelectorAll('img'));
  await Promise.all(imgs.map(img => {
    if (img.complete) return Promise.resolve();
    if (img.decode) return img.decode().catch(() => {});
    return new Promise(resolve => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
  }));
}

async function warmupPrintDocument(targetMode = 'game') {
  const activeClues = getActiveHuntClues();
  const currentTheme = AppState.selectedTheme;
  const currentLayout = PrintState.layout || 'portrait';
  const currentPaper = PrintState.paperSize || 'a4';

  if (printWarmState.isWarmed &&
      printWarmState.mode === targetMode &&
      printWarmState.layout === currentLayout &&
      printWarmState.paper === currentPaper &&
      printWarmState.theme === currentTheme &&
      printWarmState.cluesCount === activeClues.length) {
    return;
  }

  updatePrintPageStyle();

  const printCacheKey = `${targetMode}:${currentLayout}:${currentPaper}:${currentTheme}:${activeClues.length}`;
  const cachedDoc = printDocCache.get(printCacheKey);
  if (cachedDoc) {
    const root = document.getElementById('print-sheet-root');
    if (root) {
      root.className = cachedDoc.rootClassName || `print-root layout-${currentLayout} paper-${currentPaper}`;
      root.innerHTML = cachedDoc.html || '';
      await waitForPrintImages(root);
    }
    printWarmState = {
      isWarmed: true,
      mode: targetMode,
      layout: currentLayout,
      paper: currentPaper,
      theme: currentTheme,
      cluesCount: activeClues.length
    };
    return;
  }

  const requestTask = (async () => {
    const data = await apiRequest('/api/render-print', {
      method: 'POST',
      body: JSON.stringify({
        clues: huntClues,
        inStep2Or3: true,
        themeId: currentTheme,
        layout: currentLayout,
        paperSize: currentPaper,
        mode: targetMode,
        assetBaseUrl: getAssetBaseUrl()
      })
    });

    const rootClassName = data.rootClassName || `print-root layout-${currentLayout} paper-${currentPaper}`;
    const html = data.html || '';
    printDocCache.set(printCacheKey, { rootClassName, html });

    const root = document.getElementById('print-sheet-root');
    if (root) {
      root.className = rootClassName;
      root.innerHTML = html;
      await waitForPrintImages(root);
    }

    printWarmState = {
      isWarmed: true,
      mode: targetMode,
      layout: currentLayout,
      paper: currentPaper,
      theme: currentTheme,
      cluesCount: activeClues.length
    };
  })();

  activePrintPromise = requestTask;
  try {
    await requestTask;
  } catch (err) {
    console.warn('Print warmup warning:', err);
  } finally {
    if (activePrintPromise === requestTask) {
      activePrintPromise = null;
    }
  }
}

async function triggerDownloadAndPrint(mode = 'game') {
  const isAnswer = (mode === 'answer');
  const btnId = isAnswer ? 'btn-download-answer' : 'btn-download-print';
  const btn = document.getElementById(btnId);
  const originalHtml = btn ? btn.innerHTML : '';
  const originalTitle = document.title;

  try {
    const modeLabel = isAnswer ? 'Answers' : 'Clues';
    const designLabel = `Design${AppState.selectedTheme || 1}`;
    const paperLabel = (PrintState.paperSize === 'letter') ? 'US-Letter' : 'A4';
    document.title = `Easter-${modeLabel}-${designLabel}-${paperLabel}`;

    const activeClues = getActiveHuntClues();
    const isWarm = (
      printWarmState.isWarmed &&
      printWarmState.mode === mode &&
      printWarmState.layout === PrintState.layout &&
      printWarmState.paper === PrintState.paperSize &&
      printWarmState.theme === AppState.selectedTheme &&
      printWarmState.cluesCount === activeClues.length
    );

    updatePrintPageStyle();
    if (!isWarm) {
      if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.7';
        btn.innerHTML = '<span>Preparing cards...</span>';
      }
      await warmupPrintDocument(mode);
    }

    if (!printWarmState.isWarmed) {
      throw new Error('Could not build printable cards from backend API.');
    }

    window.print();
  } catch (err) {
    console.error('Print preparation error:', err);
    alert(`Print error: ${err.message}`);
  } finally {
    document.title = originalTitle;
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.innerHTML = originalHtml;
    }
  }
}

const _preloadedThemeSet = new Set();
function preloadThemeAssets(themeId = (AppState ? AppState.selectedTheme : 1) || 1) {
  if (_preloadedThemeSet.has(themeId)) return;
  _preloadedThemeSet.add(themeId);

  const prefix = getAssetBaseUrl();
  const base = prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : '';
  const urls = [];

  if (_preloadedThemeSet.size === 1) {
    urls.push(`${base}assets/graphics/clue7.svg`);
    for (let i = 1; i <= 14; i++) urls.push(`${base}assets/graphics/clue22/${i}.png`);
  }

  if (themeId === 1) {
    urls.push(`${base}assets/graphics/clue32/design1.png`);
    for (let i = 1; i <= 3; i++) urls.push(`${base}assets/theme 1/border/Border ${i}.png`);
    for (let i = 1; i <= 26; i++) urls.push(`${base}assets/graphics/theme1/${i}.png`);
    for (let i = 1; i <= 6; i++) urls.push(`${base}assets/graphics/clue11/design1/${i}.png`);
    for (let i = 1; i <= 6; i++) urls.push(`${base}assets/graphics/clue20/design1/${i}.png`);
    urls.push(`${base}assets/graphics/clue20/design1/egg.png`);
    for (let i = 1; i <= 9; i++) urls.push(`${base}assets/graphics/clue21/design1/${i}.png`);
    for (let i = 1; i <= 5; i++) {
      urls.push(`${base}assets/graphics/clue23/design1/Lock ${i}.png`);
      urls.push(`${base}assets/graphics/clue23/design1/Key ${i}.png`);
    }
    ['10.png', '10a.png', '24.png', '24a.png', '6.png', '6a.png', 'Cake.png', 'Hairband.png', 'Sofa.png', 'Television.png', 'Tree.png', 'basket.png'].forEach(f => {
      urls.push(`${base}assets/graphics/clue26/design1/${f}`);
    });
  } else if (themeId === 2) {
    urls.push(`${base}assets/theme 2/eggs/grass.png`);
    urls.push(`${base}assets/graphics/clue32/design2.png`);
    for (let i = 1; i <= 20; i++) urls.push(`${base}assets/theme 2/eggs/E${i}.png`);
    for (let i = 38; i <= 49; i++) urls.push(`${base}assets/theme 2/eggs/${i}.png`);
    for (let i = 1; i <= 6; i++) urls.push(`${base}assets/graphics/clue20/design2/${i}.png`);
    urls.push(`${base}assets/graphics/clue20/design2/egg.png`);
    for (let i = 1; i <= 9; i++) urls.push(`${base}assets/graphics/clue21/design2/${i}.png`);
    urls.push(`${base}assets/graphics/clue21/design2/1a.png`);
    for (let i = 1; i <= 5; i++) {
      urls.push(`${base}assets/graphics/clue23/design2/Lock ${i}.png`);
      urls.push(`${base}assets/graphics/clue23/design2/Key ${i}.png`);
    }
    ['10.png', '10a.png', '24.png', '24a.png', '6.png', '6a.png', 'Cake.png', 'Hairband.png', 'Sofa.png', 'Television.png', 'Tree.png', 'basket.png'].forEach(f => {
      urls.push(`${base}assets/graphics/clue26/design2/${f}`);
    });
  } else if (themeId === 3) {
    urls.push(`${base}assets/theme 3/border.png`);
    urls.push(`${base}assets/graphics/clue32/design3.png`);
    for (let i = 1; i <= 20; i++) urls.push(`${base}assets/graphics/theme3/${i}.png`);
    for (let i = 1; i <= 5; i++) urls.push(`${base}assets/graphics/clue10/design3/${i}.png`);
    for (let i = 1; i <= 6; i++) urls.push(`${base}assets/graphics/clue11/design3/${i}.png`);
    for (let i = 1; i <= 5; i++) urls.push(`${base}assets/graphics/clue15/design3/${i}.png`);
    urls.push(`${base}assets/graphics/clue19/clue19_design3.png`);
    for (let i = 1; i <= 6; i++) urls.push(`${base}assets/graphics/clue20/design3/${i}.png`);
    urls.push(`${base}assets/graphics/clue20/design3/egg.png`);
  } else if (themeId === 4) {
    urls.push(`${base}assets/graphics/clue32/design2.png`);
    for (let i = 1; i <= 12; i++) urls.push(`${base}assets/theme 4/border ${i}.png`);
  }

  urls.forEach(url => {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    if (img.decode) img.decode().catch(() => {});
  });
}

function startHuntCreator() {
  const menuPage = document.getElementById('main-menu-page');
  const appLayout = document.getElementById('app-layout');
  if (menuPage) menuPage.style.display = 'none';
  if (appLayout) appLayout.style.display = 'flex';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function returnToMainMenu() {
  const menuPage = document.getElementById('main-menu-page');
  const appLayout = document.getElementById('app-layout');
  const menuContent = document.getElementById('main-menu-content');
  if (appLayout) appLayout.style.display = 'none';
  if (menuContent) menuContent.style.display = 'flex';
  if (menuPage) menuPage.style.display = 'flex';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function initializeHuntApp() {
  selectTheme(AppState.selectedTheme || 1);
  navigateToStep(1);

  try {
    const data = await apiRequest('/api/init');
    huntClues = Array.isArray(data.clues) ? data.clues : [];
    if (data.slotLimits) backendSlotLimits = data.slotLimits;
    invalidateAllContentCaches();
    syncHidingSpots();
    renderSpotsList();
  } catch (err) {
    const list = document.getElementById('spots-list');
    if (list) {
      list.innerHTML = `
        <div style="padding: 20px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 12px; color: #9a3412;">
          <strong>Backend API offline.</strong><br>
          Start the Cloudflare Worker locally (<code>cd v2/backend && npm run dev</code>) or update <code>API_BASE_URL</code> in <code>v2/frontend/config.js</code>.
        </div>
      `;
    }
    showMappingToast(`Could not connect to backend API (${err.message})`);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  updatePrintPageStyle();
  initializeHuntApp();

  document.querySelectorAll('.step-item').forEach((el, i) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const targetStep = i + 1;
      if (targetStep === 1) navigateToStep(1);
      else if (targetStep === 2) proceedToStep2();
      else if (targetStep === 3) proceedToStep3();
    });
  });
});

