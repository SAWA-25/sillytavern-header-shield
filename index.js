/* Header Shield 1.1.0
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
        const stored = c?.extensionSettings?.[PROMPT_KEY] || c?.extensionSettings?.headerShield || {};
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
        c.extensionSettings[PROMPT_KEY] = settings;
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

function bindSettingsUI() {
    const root = document.getElementById('header-shield-settings');
    if (!root) return;
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

async function init() {
    loadSettings();

    // SillyTavern loads settings.html automatically for an extension
    // when it is present in the extension folder. No manual fetch or
    // render call is needed here.

    // Wire up the UI once it is in the DOM.
    const observer = new MutationObserver(() => {
        if (document.getElementById('header-shield-settings')) bindSettingsUI();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Also try immediately, in case the panel is already present.
    setTimeout(bindSettingsUI, 500);

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
        buildHeader, applyShield, loadSettings, saveSettings,
        getSettings: () => ({ ...settings }),
        getLastStats: () => lastStats,
        getLog: () => [...logEntries],
    };

    if (settings.enabled) {
        toast('success', `头部护盾已就绪 · 默认 ${settings.minChars.toLocaleString()}~${settings.maxChars.toLocaleString()} 字`);
    }
}

init();
