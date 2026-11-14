/* Header Shield 1.1.3
 * A SillyTavern third-party extension.
 * What it does, in plain terms:
 *  - Before each generation it builds a short, per-request random
 *    header (math / science filler) with a fresh nonce, and registers
 *    it with SillyTavern as an extension prompt. That makes the very
 *    start of the prompt different every time, so a provider that
 *    keys a cache / fingerprint on the prompt prefix is much less
 *    likely to hit the same prefix twice.
 *  - It does NOT, and cannot, force a third-party channel to use a
 *    particular model. If a channel substitutes models server-side,
 *    only the channel, the official API, or switching provider can
 *    fix that. This extension makes substitution harder to hide:
 *    it records the model name SillyTavern reports for each reply
 *    and warns when it differs from the expected model you set.
 *  - Defaults are deliberately small (2,000-4,000 chars). The old
 *    script default of 12,000-20,000 chars is kept only as the
 *    "extreme" preset, with a cost warning.
 */

const EXTENSION_NAME = 'Header Shield';
// Folder name as installed from Git: the repo name, not "header-shield".
// MemoryLayers (which works on this same instance) uses the same form:
//   renderExtensionTemplateAsync('third-party/SillyTavern-MemoryLayers', 'settings')
const EXTENSION_ID = 'third-party/sillytavern-header-shield';
const EXTENSION_FOLDER_CANDIDATES = [
    'third-party/sillytavern-header-shield',
    'third-party/header-shield',
];
const SETTINGS_KEY = 'header-shield';
const CURRENT_VERSION = '1.1.3';
const REPO_URL = 'https://github.com/SAWA-25/sillytavern-header-shield';
const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/SAWA-25/sillytavern-header-shield/main/manifest.json';
const PROMPT_KEY = 'header_shield';
const MARKER = '[header-shield]';

// BEFORE_PROMPT = 2, IN_CHAT = 1, IN_PROMPT = 0 in SillyTavern.
const POSITION_BEFORE_PROMPT = 2;
const ROLE_SYSTEM = 0;

const PRESETS = {
    light: { minChars: 800, maxChars: 1500, label: '轻量' },
    balanced: { minChars: 2000, maxChars: 4000, label: '均衡' },
    strong: { minChars: 6000, maxChars: 9000, label: '较强' },
    extreme: { minChars: 12000, maxChars: 20000, label: '极限（旧版，费 token）' },
};

const DEFAULT_SETTINGS = {
    enabled: true,
    preset: 'balanced',
    minChars: 2000,
    maxChars: 4000,
    mathRatio: 70,
    style: 'math_mixed', // math_mixed | math_pure | mixed | encyclopedia
    showToast: true,
    expectedModel: 'gemini-4-argon',
    logEnabled: true,
    authorName: 'suki',
    fictionAnchorEnabled: true,
    fictionAnchorText: '',
};

let settings = { ...DEFAULT_SETTINGS };
let lastStats = null;
let logEntries = [];

function ctx() {
    return globalThis.SillyTavern?.getContext?.();
}

function loadSettings() {
    try {
        const c = ctx();
        const stored = c?.extensionSettings?.[SETTINGS_KEY]
            || c?.extensionSettings?.[PROMPT_KEY]
            || c?.extensionSettings?.headerShield
            || {};
        settings = { ...DEFAULT_SETTINGS, ...stored };
        // Preset wins for length unless the user edited the numbers.
        if (PRESETS[settings.preset]) {
            const p = PRESETS[settings.preset];
            // Only apply preset lengths when they match a preset exactly
            // or when the stored values are still the old defaults.
            if (settings.minChars === 12000 || settings.maxChars === 20000 || !stored.minChars) {
                settings.minChars = p.minChars;
                settings.maxChars = p.maxChars;
            }
        }
        settings.minChars = Math.max(200, Math.min(60000, Number(settings.minChars) || 2000));
        settings.maxChars = Math.max(settings.minChars, Math.min(60000, Number(settings.maxChars) || 4000));
        settings.mathRatio = Math.max(0, Math.min(100, Number(settings.mathRatio) || 70));
    } catch (e) {
        console.warn('[Header Shield] loadSettings failed, using defaults', e);
        settings = { ...DEFAULT_SETTINGS };
    }
    return settings;
}

function saveSettings() {
    try {
        const c = ctx();
        if (!c?.extensionSettings) return;
        c.extensionSettings[SETTINGS_KEY] = settings;
        c.saveSettingsDebounced?.();
    } catch (e) {
        console.warn('[Header Shield] saveSettings failed', e);
    }
}

function toast(level, message, title = EXTENSION_NAME) {
    try {
        if (globalThis.toastr?.[level]) globalThis.toastr[level](message, title);
    } catch (_) { /* no-op */ }
    console.log(`[Header Shield] ${message}`);
}

// --- CSPRNG, no Math.random() for the seed / nonce ---
function randomFloat() {
    try {
        const buf = new Uint32Array(1);
        globalThis.crypto.getRandomValues(buf);
        return buf[0] / 4294967296;
    } catch (_) {
        return Math.random();
    }
}
function randomInt(min, max) {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return Math.floor(lo + randomFloat() * (hi - lo + 1));
}
function randomHex(len = 12) {
    const chars = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < len; i++) out += chars[randomInt(0, 15)];
    return out;
}
function pick(arr) { return arr[randomInt(0, arr.length - 1)]; }
function randomCoeff() {
    if (randomFloat() > 0.5) return `${randomInt(1, 29)}/${randomInt(2, 37)}`;
    return `${randomInt(1, 49)}.${randomInt(10, 99)}`;
}

// --- Compact filler generator (own wording, small template set) ---
const MATH_TOPICS = [
    'nonlinear partial differential equations',
    'spectral theory of self-adjoint operators',
    'Riemannian geometry and curvature flow',
    'stochastic differential equations',
    'algebraic topology and homology',
    'variational methods and critical points',
    'complex manifolds and Kahler metrics',
    'functional analysis in Sobolev spaces',
];
const SCIENCE_TOPICS = [
    'ocean currents and thermohaline circulation',
    'photosynthesis and carbon fixation',
    'plate tectonics and mantle convection',
    'stellar nucleosynthesis',
    'glacial hydrology',
    'enzyme kinetics',
    'atmospheric circulation',
    'deep-sea ecosystems',
];

function makeMathBlock(i) {
    const dim = randomInt(3, 12);
    const p = randomInt(2, 9);
    const topic = pick(MATH_TOPICS);
    const a = randomCoeff();
    const b = randomCoeff();
    const seed = randomHex(6).toUpperCase();
    return [
        `Problem ${i} [${seed}] — ${topic}.`,
        `Let Omega be a bounded domain in R^${dim}. Consider an equation with coefficients ${a} and ${b}, exponent p = ${p}, and a nonlocal coupling term.`,
        `Task: establish an a priori energy estimate, show local existence of a weak solution, and bound the gradient in terms of the initial energy. State the assumptions, then outline the estimate in three steps.`,
        `Check: the determinant computed in this instance is ${(randomFloat() * 100 + 1).toFixed(6)}; the corresponding decay rate is proportional to exp(-${randomCoeff()} t).`,
    ].join('\n');
}

function makeScienceBlock(i) {
    const topic = pick(SCIENCE_TOPICS);
    const n1 = randomInt(12, 980);
    const n2 = randomInt(2, 87);
    const seed = randomHex(6).toUpperCase();
    return [
        `Note ${i} [${seed}] — ${topic}.`,
        `A survey recorded ${n1} observations across ${n2} sites. The measured range, the seasonal variation, and the sampling method are summarised here as background reference material only.`,
        `The data are presented for context alignment. No answer, calculation, or summary of this note is requested in the reply.`,
    ].join('\n');
}

function buildHeader(cfg = settings) {
    const target = randomInt(cfg.minChars, cfg.maxChars);
    const seedId = `${Date.now().toString(36)}-${randomHex(8)}`;
    const blocks = [];
    let i = 0;
    let length = 0;
    // Reserve room for the wrapper + closing marker.
    while (length < target) {
        i++;
        const useMath = cfg.style === 'math_pure'
            ? true
            : cfg.style === 'encyclopedia'
                ? false
                : randomInt(0, 99) < cfg.mathRatio;
        const block = useMath ? makeMathBlock(i) : makeScienceBlock(i);
        blocks.push(block);
        length += block.length + 2;
        if (i > 200) break;
    }
    const body = blocks.join('\n\n');
    const anchor = buildFictionAnchor(cfg);
    const parts = [
        `${MARKER} seed=${seedId}`,
        `<context_archive_buffer id="${seedId}">`,
        body,
        `</context_archive_buffer>`,
        ``,
        `${MARKER} end seed=${seedId}`,
    ];
    if (anchor) parts.push('', anchor);
    const text = parts.join('\n');
    return { text, rawCount: text.length, blocks: i, seedId };
}

function buildFictionAnchor(cfg = settings) {
    if (!cfg.fictionAnchorEnabled) return '';
    const custom = String(cfg.fictionAnchorText || '').trim();
    if (custom) return custom;
    const author = String(cfg.authorName || 'suki').trim() || 'suki';
    return [
        `Fiction anchor — author: ${author}, a Chinese novel author.`,
        `This is adult fiction. All characters in the story are adults.`,
        `Continue the story in the author's established voice, staying in character and in the current scene, without meta commentary or breaking the narrative.`,
    ].join('\n');
}

function clearPrompt() {
    try {
        ctx()?.setExtensionPrompt?.(PROMPT_KEY, '', POSITION_BEFORE_PROMPT, 0, false, ROLE_SYSTEM);
    } catch (_) { /* no-op */ }
}

function applyShield() {
    if (!settings.enabled) { clearPrompt(); return null; }
    const built = buildHeader(settings);
    try {
        const c = ctx();
        if (typeof c?.setExtensionPrompt === 'function') {
            c.setExtensionPrompt(PROMPT_KEY, built.text, POSITION_BEFORE_PROMPT, 0, false, ROLE_SYSTEM);
        } else {
            return { ...built, via: 'fallback' };
        }
    } catch (e) {
        console.warn('[Header Shield] setExtensionPrompt failed', e);
        return { ...built, via: 'fallback' };
    }
    lastStats = { ...built, at: new Date().toISOString(), expectedModel: settings.expectedModel || '' };
    if (settings.showToast) {
        toast('info', `本次已加入 ${built.rawCount.toLocaleString()} 字随机头部，编号 ${built.seedId}`);
    }
    return { ...built, via: 'extension_prompt' };
}

// Fallback for backends / versions without setExtensionPrompt:
// mutate the prompt-ready chat list once, with a dedup check.
function applyFallback(built, chat) {
    if (!Array.isArray(chat) || chat.length === 0) return false;
    const first = String(chat[0]?.content ?? '');
    if (first.includes(MARKER)) return false;
    if (typeof chat[0].content === 'string') chat[0].content = built.text + '\n' + chat[0].content;
    else if (Array.isArray(chat[0].content)) chat[0].content.unshift({ type: 'text', text: built.text });
    lastStats = { ...built, at: new Date().toISOString(), expectedModel: settings.expectedModel || '' };
    return true;
}

function observedModelFromChat() {
    try {
        const chat = ctx()?.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (!m || m.is_user) continue;
            const extra = m.extra || {};
            const model = extra.model || extra?.gen_id || m.model || '';
            const api = extra.api || '';
            if (model || api) return { model: String(model || ''), api: String(api || '') };
            return { model: '', api: '' };
        }
    } catch (_) { /* no-op */ }
    return { model: '', api: '' };
}

function recordGeneration() {
    if (!settings.logEnabled) return;
    const obs = observedModelFromChat();
    const expected = (settings.expectedModel || '').trim();
    const entry = {
        at: new Date().toLocaleTimeString(),
        seed: lastStats?.seedId || '-',
        chars: lastStats?.rawCount || 0,
        expected: expected || '-',
        observed: obs.model || '(未返回模型名)',
        api: obs.api || '-',
        match: expected && obs.model ? obs.model.toLowerCase().includes(expected.toLowerCase()) : null,
    };
    logEntries.unshift(entry);
    logEntries = logEntries.slice(0, 20);
    if (entry.match === false) {
        toast('warning', `期望模型 ${expected}，但本次回复报告为 ${obs.model}，可能被路由到其他模型。请检查渠道 / API 设置。`);
    }
    if (obs.model && obs.model.toLowerCase().includes('flash') && expected.toLowerCase().includes('argon')) {
        toast('warning', `检测到 flash 模型：期望 ${expected}，实际 ${obs.model}。中转可能把 argon 映射到了 flash，请向渠道确认映射关系。`);
    }
    renderLog();
}

function renderLog() {
    const el = document.getElementById('hs-log');
    if (!el) return;
    if (!logEntries.length) { el.textContent = '还没有记录。发一条消息后这里会显示模型名。'; return; }
    el.innerHTML = logEntries.map(e => {
        const flag = e.match === false ? ' ⚠️ 不一致' : e.match === true ? ' ✓ 一致' : '';
        return `<div class="hs-log-row"><span>${e.at}</span><span>${e.chars} 字</span><span>期望 ${e.expected}</span><span>实际 ${e.observed}${flag}</span></div>`;
    }).join('');
}

function compareVersions(a, b) {
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

async function checkUpdate() {
    const statusEl = document.getElementById('hs-update-status');
    const setStatus = (text) => { if (statusEl) statusEl.textContent = text; };
    setStatus('正在检查更新…');
    try {
        const res = await fetch(`${REMOTE_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const remote = await res.json();
        const latest = String(remote?.version || '').trim();
        if (!latest) throw new Error('远程 manifest 里没有版本号');
        const now = new Date().toLocaleTimeString();
        if (compareVersions(latest, CURRENT_VERSION) > 0) {
            setStatus(`发现新版 ${latest}，你现在是 ${CURRENT_VERSION}（${now} 检查）。请在酒馆扩展列表里点 Header Shield 的“更新”，更新完刷新酒馆。`);
            toast('warning', `发现新版 ${latest}，请在扩展列表里更新 Header Shield。`);
            return { current: CURRENT_VERSION, latest, hasUpdate: true };
        }
        setStatus(`已是最新版 ${CURRENT_VERSION}（${now} 检查）。`);
        toast('success', `Header Shield 已是最新版 ${CURRENT_VERSION}`);
        return { current: CURRENT_VERSION, latest, hasUpdate: false };
    } catch (e) {
        console.warn('[Header Shield] checkUpdate failed', e);
        setStatus(`检查失败：${e?.message || e}。请确认能打开 GitHub，或直接打开仓库看最新版。`);
        toast('error', '检查更新失败，请稍后再试。');
        return { current: CURRENT_VERSION, latest: '', hasUpdate: false, error: String(e?.message || e) };
    }
}

function bindSettingsUI() {
    const root = document.getElementById('header-shield-settings');
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';
    const q = (id) => root.querySelector(id);
    const enabled = q('#hs-enabled');
    const preset = q('#hs-preset');
    const minEl = q('#hs-min');
    const maxEl = q('#hs-max');
    const ratio = q('#hs-ratio');
    const ratioVal = q('#hs-ratio-val');
    const style = q('#hs-style');
    const toastEl = q('#hs-toast');
    const expected = q('#hs-expected-model');
    const fictionEl = q('#hs-fiction-anchor');
    const authorEl = q('#hs-author-name');
    const fictionTextEl = q('#hs-fiction-text');
    const testBtn = q('#hs-test');
    const preview = q('#hs-preview');
    const saveBtn = q('#hs-save');
    const checkBtn = q('#hs-check-update');
    const repoBtn = q('#hs-open-repo');
    const versionEl = q('#hs-current-version');

    if (enabled) enabled.checked = !!settings.enabled;
    if (preset) preset.value = settings.preset;
    if (minEl) minEl.value = settings.minChars;
    if (maxEl) maxEl.value = settings.maxChars;
    if (ratio) ratio.value = settings.mathRatio;
    if (ratioVal) ratioVal.textContent = `${settings.mathRatio}%`;
    if (style) style.value = settings.style;
    if (toastEl) toastEl.checked = !!settings.showToast;
    if (expected) expected.value = settings.expectedModel || '';
    if (fictionEl) fictionEl.checked = !!settings.fictionAnchorEnabled;
    if (authorEl) authorEl.value = settings.authorName || 'suki';
    if (fictionTextEl) fictionTextEl.value = settings.fictionAnchorText || '';
    if (versionEl) versionEl.textContent = CURRENT_VERSION;
    checkBtn?.addEventListener('click', () => { checkUpdate(); });
    repoBtn?.addEventListener('click', () => { globalThis.open(REPO_URL, '_blank'); });

    preset?.addEventListener('change', () => {
        const p = PRESETS[preset.value];
        if (p && minEl && maxEl) { minEl.value = p.minChars; maxEl.value = p.maxChars; }
    });
    ratio?.addEventListener('input', () => { if (ratioVal) ratioVal.textContent = `${ratio.value}%`; });
    testBtn?.addEventListener('click', () => {
        const sample = buildHeader({
            ...settings,
            minChars: Number(minEl?.value) || settings.minChars,
            maxChars: Number(maxEl?.value) || settings.maxChars,
        });
        if (preview) preview.textContent = sample.text.slice(0, 1200) + '\n…';
        toast('info', `预览已生成 ${sample.rawCount.toLocaleString()} 字，编号 ${sample.seedId}`);
    });
    saveBtn?.addEventListener('click', () => {
        const presetVal = preset?.value || 'balanced';
        const p = PRESETS[presetVal];
        settings = {
            ...settings,
            enabled: enabled?.checked ?? true,
            preset: presetVal,
            minChars: Number(minEl?.value) || p.minChars,
            maxChars: Number(maxEl?.value) || p.maxChars,
            mathRatio: Number(ratio?.value ?? 70),
            style: style?.value || 'math_mixed',
            showToast: toastEl?.checked ?? true,
            expectedModel: (expected?.value || '').trim(),
            fictionAnchorEnabled: fictionEl?.checked ?? true,
            authorName: (authorEl?.value || 'suki').trim() || 'suki',
            fictionAnchorText: (fictionTextEl?.value || '').trim(),
        };
        if (settings.maxChars < settings.minChars) settings.maxChars = settings.minChars;
        saveSettings();
        applyShield();
        toast('success', '设置已保存');
    });
    renderLog();
}

async function loadSettingsUI() {
    // Official pattern, copied from SillyTavern core + MemoryLayers
    // (which renders fine on this same instance):
    //   const html = await context.renderExtensionTemplateAsync(
    //       'third-party/<folder-name>', 'settings');
    //   document.getElementById('extensions_settings')
    //       .insertAdjacentHTML('beforeend', html);
    // The previous version fetched a hard-coded wrong path
    // 'scripts/extensions/third-party/header-shield/settings.html'
    // (the installed folder is 'sillytavern-header-shield'), so the
    // fetch 404'd and no panel ever appeared — even though index.js
    // itself ran fine, which is why the toast still showed.
    if (document.getElementById('header-shield-settings')) { bindSettingsUI(); return true; }
    const container = document.getElementById('extensions_settings')
        || document.getElementById('extensions_settings2');
    if (!container) {
        console.warn('[Header Shield] extensions settings container not found yet');
        return false;
    }
    let html = '';
    const c = ctx();
    if (typeof c?.renderExtensionTemplateAsync === 'function') {
        for (const name of EXTENSION_FOLDER_CANDIDATES) {
            try {
                html = await c.renderExtensionTemplateAsync(name, 'settings');
                if (html && String(html).includes('header-shield-settings')) break;
                html = '';
            } catch (e) {
                console.warn(`[Header Shield] renderExtensionTemplateAsync failed for ${name}`, e);
            }
        }
    }
    if (!html) {
        // Fallback: plain fetch, trying both possible folder names.
        for (const name of EXTENSION_FOLDER_CANDIDATES) {
            try {
                const res = await fetch(`scripts/extensions/${name}/settings.html`, { cache: 'no-store' });
                if (res.ok) { html = await res.text(); break; }
                console.warn(`[Header Shield] settings.html fetch ${name}: HTTP ${res.status}`);
            } catch (e) {
                console.warn(`[Header Shield] settings.html fetch failed for ${name}`, e);
            }
        }
    }
    if (!html) {
        console.error('[Header Shield] Failed to load settings.html from all candidates');
        return false;
    }
    container.insertAdjacentHTML('beforeend', html);
    bindSettingsUI();
    return true;
}

async function loadSettingsUIWithRetries() {
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            if (await loadSettingsUI()) return true;
        } catch (e) {
            console.warn('[Header Shield] loadSettingsUI attempt failed', e);
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    toast('error', '没能加载设置面板 settings.html，请刷新酒馆，或在控制台看 [Header Shield] 的报错。');
    return false;
}

async function init() {
    loadSettings();
    // Like MemoryLayers: wait for jQuery ready, then render settings.
    // The drawer container may not be ready when the script first runs,
    // so retry for up to ~10s instead of giving up after one attempt.
    loadSettingsUIWithRetries();

    const c = ctx();
    const events = c?.eventSource;
    const types = c?.event_types;
    if (events?.on && types) {
        // Build the shield before generation starts.
        if (types.GENERATION_STARTED) events.on(types.GENERATION_STARTED, () => { loadSettings(); applyShield(); });
        // Fallback / safety net for prompt-ready.
        if (types.CHAT_COMPLETION_PROMPT_READY) {
            events.on(types.CHAT_COMPLETION_PROMPT_READY, (data) => {
                if (!settings.enabled || data?.dryRun) return;
                const built = applyShield();
                if (built?.via === 'fallback') applyFallback(built, data?.chat);
            });
        }
        if (types.MESSAGE_RECEIVED) events.on(types.MESSAGE_RECEIVED, recordGeneration);
        if (types.GENERATION_ENDED) events.on(types.GENERATION_ENDED, recordGeneration);
        if (types.CHAT_CHANGED) events.on(types.CHAT_CHANGED, () => { lastStats = null; clearPrompt(); });
    } else {
        console.warn('[Header Shield] eventSource / event_types unavailable; shield will only apply when settings are saved.');
    }

    // Expose a small debug handle for the settings panel / console.
    globalThis.HeaderShield = {
        buildHeader, applyShield, loadSettings, saveSettings, checkUpdate, loadSettingsUI,
        version: CURRENT_VERSION,
        getSettings: () => ({ ...settings }),
        getLastStats: () => lastStats,
        getLog: () => [...logEntries],
    };

    if (settings.enabled) {
        toast('success', `头部护盾已就绪 · 默认 ${settings.minChars.toLocaleString()}~${settings.maxChars.toLocaleString()} 字`);
    }
}

if (typeof globalThis.jQuery === 'function') {
    globalThis.jQuery(() => { init(); });
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); });
} else {
    init();
}
