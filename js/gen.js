// ========== GENERATIVE LLM (opt-in, local-only) ==========
// Mirrors js/intel.js but loads a small instruct-tuned text-generation
// pipeline for the Ask feature. Strictly opt-in: nothing happens until
// the user flips a Settings toggle AND clicks download. No cloud LLM,
// no analytics, no fetch besides the one-time model weights from the
// same Hugging Face CDN already used by the embedding model.

const GEN_TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.1';
const GEN_CFG_KEY = 'stupind_gen_cfg';
const GEN_HIST_KEY = 'stupind_gen_history';

// Published instruct-tuned models with ONNX weights. The HuggingFaceTB
// originals and onnx-community repacks both ship ONNX weights under onnx/.
// If one namespace is unreachable, the other usually works — so we surface
// both as presets and auto-retry the sibling on load failure.
const GEN_MODEL_PRESETS = [
  { id:'HuggingFaceTB/SmolLM2-360M-Instruct',        dtype:'q4', sizeMb:230, label:'SmolLM2 360M (balanced)',       note:'Recommended for most devices' },
  { id:'HuggingFaceTB/SmolLM2-135M-Instruct',        dtype:'q4', sizeMb:100, label:'SmolLM2 135M (tiny)',           note:'Lowest RAM — older phones' },
  { id:'onnx-community/Qwen2.5-0.5B-Instruct',       dtype:'q4', sizeMb:320, label:'Qwen2.5 0.5B (bigger)',         note:'Desktop / WebGPU preferred' },
  { id:'onnx-community/SmolLM2-360M-Instruct',       dtype:'q4', sizeMb:230, label:'SmolLM2 360M (onnx-community)', note:'Use if HuggingFaceTB mirror fails' },
  { id:'onnx-community/SmolLM2-135M-Instruct-ONNX',  dtype:'q4', sizeMb:100, label:'SmolLM2 135M (onnx-community)', note:'Use if HuggingFaceTB mirror fails' },
];

// Slugs we'll transparently retry if the primary 401/403/404s.
const GEN_MODEL_ALT_SLUGS = {
  'HuggingFaceTB/SmolLM2-360M-Instruct': 'onnx-community/SmolLM2-360M-Instruct',
  'HuggingFaceTB/SmolLM2-135M-Instruct': 'onnx-community/SmolLM2-135M-Instruct-ONNX',
};

// Any pre-v27 config that points at the stale Xenova/* slugs gets reset to
// the current default preset. Keeps existing users from hitting a 401.
const GEN_CFG_VERSION = 2;

let _genPipe = null;
let _genReady = false;
let _genLoading = false;
let _genGenerating = false;
let _genDevice = null;
let _genModelId = null;
let _genLoadPromise = null;
let _genLoadAbortCtl = null;
let _genAbortCtl = null;
let _genLastError = null;
let _genStoppingCriteria = null; // InterruptableStoppingCriteria instance (if available)
let _genTransformersMod = null;  // cached module handle

function getGenDevice(){ return _genDevice; }
function getGenModel(){ return _genModelId; }
function isGenReady(){ return _genReady; }
function isGenLoading(){ return _genLoading; }
function isGenGenerating(){ return _genGenerating; }
function isGenBusy(){ return _genLoading || _genGenerating; }
function getGenLastError(){ return _genLastError; }
function clearGenLastError(){ _genLastError = null; }

async function _importTransformers(){
  if(_genTransformersMod) return _genTransformersMod;
  _genTransformersMod = await import(GEN_TRANSFORMERS_CDN);
  return _genTransformersMod;
}

function _pickDefaultPresetForDevice(){
  // Low-RAM devices default to the Tiny preset; otherwise the Balanced one.
  if(typeof navigator !== 'undefined' && typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 4){
    const tiny = GEN_MODEL_PRESETS.find(p => /135M/i.test(p.label));
    if(tiny) return tiny;
  }
  return GEN_MODEL_PRESETS[0];
}

function _loadGenCfg(){
  let cfg = {};
  try{ cfg = JSON.parse(localStorage.getItem(GEN_CFG_KEY) || '{}') || {}; }
  catch(e){ cfg = {}; }
  const fresh = !cfg.modelId;
  if(typeof cfg.enabled !== 'boolean') cfg.enabled = false;
  if(fresh){
    const preset = _pickDefaultPresetForDevice();
    cfg.modelId = preset.id;
    cfg.dtype   = preset.dtype;
  }
  if(!cfg.dtype)  cfg.dtype  = GEN_MODEL_PRESETS[0].dtype;
  if(typeof cfg.timeoutSec !== 'number') cfg.timeoutSec = _defaultTimeoutSec();

  // Per-model download record. Back-compat for installs predating downloadedIds:
  // legacy `downloaded:true` means the currently-selected model was the last
  // one fetched, so seed that id into the array.
  if(!Array.isArray(cfg.downloadedIds)){
    cfg.downloadedIds = (cfg.downloaded === true && cfg.modelId) ? [cfg.modelId] : [];
  }

  // Migrate: old builds wrote Xenova/SmolLM2-* ids that don't exist on HF.
  // Also fall forward to the current default if the stored id isn't in the
  // preset list so users never get stuck on a stale slug. When migrating off
  // a dead slug we purge the downloadedIds cache too — those weights never
  // actually landed in the browser cache.
  const known = GEN_MODEL_PRESETS.some(p => p.id === cfg.modelId);
  if(!known || cfg.cfgVersion !== GEN_CFG_VERSION){
    const preset = _pickDefaultPresetForDevice();
    cfg.modelId = preset.id;
    cfg.dtype = preset.dtype;
    cfg.downloadedIds = cfg.downloadedIds.filter(id => GEN_MODEL_PRESETS.some(p => p.id === id));
    cfg.cfgVersion = GEN_CFG_VERSION;
  }

  // Keep the legacy boolean in sync for any external readers.
  cfg.downloaded = cfg.downloadedIds.includes(cfg.modelId);
  return cfg;
}

/** True if weights for `modelId` have been fetched at least once on this device. */
function isGenDownloaded(modelId){
  if(!modelId) return false;
  const cfg = _loadGenCfg();
  return cfg.downloadedIds.includes(modelId);
}

/** Record a successful download for `modelId`. */
function markGenDownloaded(modelId){
  if(!modelId) return;
  const cfg = _loadGenCfg();
  if(!cfg.downloadedIds.includes(modelId)) cfg.downloadedIds.push(modelId);
  cfg.downloaded = cfg.downloadedIds.includes(cfg.modelId);
  _saveGenCfg(cfg);
}

function _saveGenCfg(cfg){
  try{ localStorage.setItem(GEN_CFG_KEY, JSON.stringify(cfg)); }catch(e){}
}

function _defaultTimeoutSec(){
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  return isMobile ? 30 : 60;
}

function _mobileRamHint(){
  // Very coarse hint; iOS Safari does not report deviceMemory, fall back to agent.
  if(typeof navigator === 'undefined') return null;
  const dm = navigator.deviceMemory;
  if(typeof dm === 'number' && dm < 4) return 'low';
  if(/iPhone|iPad|iPod/.test(navigator.userAgent || '')) return 'ios-unknown';
  return null;
}

function getGenPresets(){ return GEN_MODEL_PRESETS.slice(); }
function getGenCfg(){ return _loadGenCfg(); }
function saveGenCfg(cfg){ _saveGenCfg(cfg); return cfg; }

function getAskHistory(){
  try{ const arr = JSON.parse(localStorage.getItem(GEN_HIST_KEY) || '[]'); return Array.isArray(arr) ? arr : []; }
  catch(e){ return []; }
}
function pushAskHistory(text){
  const s = String(text || '').trim();
  if(!s) return;
  const arr = getAskHistory().filter(x => x && x.text !== s);
  arr.unshift({ ts: Date.now(), text: s.slice(0, 280) });
  try{ localStorage.setItem(GEN_HIST_KEY, JSON.stringify(arr.slice(0, 5))); }catch(e){}
}
function clearAskHistory(){
  try{ localStorage.removeItem(GEN_HIST_KEY); }catch(e){}
}

/**
 * Best-effort "clear cached LLM weights." Transformers.js uses the browser
 * HTTP cache (not IndexedDB), so we can only clear caches *we* own — anything
 * the browser auto-caches is left to "Clear site data." We scan for any
 * Cache Storage entries that look like HF weights and delete them.
 * Returns the number of cache entries removed.
 */
async function clearLLMCache(){
  if(typeof caches === 'undefined' || !caches.keys) return 0;
  let removed = 0;
  try{
    const keys = await caches.keys();
    for(const k of keys){
      // Only touch caches we might have created, not the PWA shell cache.
      if(k && /transformers|huggingface|gen|llm/i.test(k) && !/odtaulai-v\d/.test(k)){
        const ok = await caches.delete(k);
        if(ok) removed++;
      }
    }
  }catch(e){ /* swallow */ }
  return removed;
}

function _isMissingFileError(e){
  const m = String((e && e.message) || e || '');
  return /Unauthorized|status:\s*40[134]|404|\bnot found\b/i.test(m);
}

/**
 * Load the text-generation pipeline. Does nothing if already loaded for this
 * modelId.
 *
 * Concurrency:
 *   - Same model already loading → return the in-flight promise.
 *   - *Different* model requested while one is mid-load → reject with
 *     GEN_SWITCH_IN_PROGRESS so callers never silently receive the wrong
 *     pipeline. (The UI disables the model dropdown while loading to avoid
 *     tripping this in practice.)
 *
 * Supports abort via genAbortLoad() and auto-retries an alternate namespace
 * (e.g. `onnx-community/*`) when the primary repo returns 401/403/404.
 *
 * @param {string} modelId
 * @param {string} dtype
 * @param {(progress: { progress?:number, status?:string, file?:string }) => void} [onProgress]
 */
async function genLoad(modelId, dtype, onProgress){
  if(!modelId) throw new Error('GEN_NO_MODEL');
  if(_genReady && _genModelId === modelId) return;
  if(_genLoadPromise){
    if(_genModelId === modelId) return _genLoadPromise;
    throw new Error('GEN_SWITCH_IN_PROGRESS');
  }

  _genLoading = true;
  _genModelId = modelId;
  _genReady = false;
  _genPipe = null;
  _genDevice = null;
  _genLastError = null;
  _genLoadAbortCtl = new AbortController();
  const loadSignal = _genLoadAbortCtl.signal;

  const cb = typeof onProgress === 'function' ? onProgress : () => {};

  _genLoadPromise = (async () => {
    let pipeline, env;
    try{
      const mod = await _importTransformers();
      pipeline = mod.pipeline;
      env = mod.env;
    }catch(e){
      _genLastError = 'Failed to load Transformers.js from CDN: ' + (e.message || e);
      throw e;
    }
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    // On WebGPU we prefer q4f16 (int4 weights + fp16 activations) when the
    // caller's stored dtype is plain q4; on WASM we use q4 (fp16 activations
    // aren't supported). This mirrors what works across Transformers.js v3.
    const webgpuDtype = dtype === 'q4' ? 'q4f16' : (dtype || 'q4f16');
    const wasmDtype   = dtype === 'q4f16' ? 'q4' : (dtype || 'q4');

    const tryPipeline = async (slug) => {
      try{
        if(loadSignal.aborted) throw new Error('LOAD_ABORTED');
        _genPipe = await pipeline('text-generation', slug, {
          device: 'webgpu',
          dtype: webgpuDtype,
          progress_callback: cb,
        });
        _genDevice = 'webgpu';
      }catch(e){
        if(loadSignal.aborted) throw new Error('LOAD_ABORTED');
        console.warn('[gen] WebGPU pipeline failed, falling back to WASM', e);
        _genPipe = await pipeline('text-generation', slug, {
          device: 'wasm',
          dtype: wasmDtype,
          progress_callback: cb,
        });
        _genDevice = 'wasm';
      }
    };

    let finalSlug = modelId;
    try{
      await tryPipeline(modelId);
    }catch(e){
      if(String(e && e.message) === 'LOAD_ABORTED') throw e;
      const alt = GEN_MODEL_ALT_SLUGS[modelId];
      if(alt && _isMissingFileError(e)){
        console.warn('[gen] primary slug failed, retrying alternate:', alt);
        cb({ status: 'retry', file: alt, progress: 0 });
        _genModelId = alt;
        finalSlug = alt;
        await tryPipeline(alt);
        // Persist the working slug so next session doesn't re-try the
        // dead primary. User can still switch back via the dropdown.
        try{
          const cfg = _loadGenCfg();
          cfg.modelId = alt;
          _saveGenCfg(cfg);
        }catch(_){}
      } else {
        throw e;
      }
    }
    _genReady = true;
    _genLastError = null;
    // Record successful download against whichever slug actually resolved, so
    // the "cached" indicator matches what's in the browser HTTP cache.
    try{ markGenDownloaded(finalSlug); }catch(_){}
  })().catch(err => {
    _genPipe = null;
    _genReady = false;
    _genDevice = null;
    const msg = (err && err.message) ? err.message : String(err);
    if(msg === 'LOAD_ABORTED'){
      _genLastError = 'Download cancelled.';
    } else if(msg !== 'GEN_SWITCH_IN_PROGRESS'){
      _genLastError = _friendlyGenError(msg, modelId);
    }
    throw err;
  }).finally(() => {
    _genLoading = false;
    _genLoadPromise = null;
    _genLoadAbortCtl = null;
  });

  return _genLoadPromise;
}

/**
 * Cancel an in-flight model download. Transformers.js v3 honors an abort by
 * detecting it in our signal guard at each tryPipeline() step, so the next
 * `await` after the abort rejects with LOAD_ABORTED. In-flight fetches
 * already running will complete, but nothing further starts.
 */
function genAbortLoad(){
  if(_genLoadAbortCtl){
    try{ _genLoadAbortCtl.abort(); }catch(e){}
  }
}

function _friendlyGenError(msg, modelId){
  const m = String(msg || '');
  if(/Unauthorized|403|404|not found/i.test(m)){
    return `Model "${modelId}" could not be downloaded. The repo may be private, missing, or not published with ONNX weights. Try a different preset. Raw: ${m.slice(0, 120)}`;
  }
  if(/NetworkError|Failed to fetch/i.test(m)){
    return 'Network error while downloading model weights. Check connection and retry.';
  }
  if(/out of memory|OOM|Allocation failed/i.test(m)){
    return 'Device ran out of memory loading the model. Try the smaller Tiny (135M) preset.';
  }
  return 'Load failed: ' + m.slice(0, 180);
}

/**
 * Cancel an in-flight generation. Uses Transformers.js v3's
 * InterruptableStoppingCriteria when available so decoding actually halts
 * (vs. rejecting the promise but letting tokens keep decoding in the bg).
 */
function genAbort(){
  if(_genStoppingCriteria && typeof _genStoppingCriteria.interrupt === 'function'){
    try{ _genStoppingCriteria.interrupt(); }catch(e){}
  }
  if(_genAbortCtl){
    try{ _genAbortCtl.abort(); }catch(e){}
  }
}

/**
 * Generate text. Streams tokens via onToken if provided.
 * @param {{ messages?:Array, prompt?:string, maxTokens?:number, temperature?:number, onToken?:(t:string)=>void, signal?:AbortSignal }} opts
 * @returns {Promise<string>} Full generated text (without the prompt).
 */
async function genGenerate(opts){
  if(!_genReady || !_genPipe) throw new Error('GEN_NOT_READY');
  const maxTokens   = Math.min(1024, Math.max(16, opts.maxTokens || 512));
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.2;
  const onToken     = typeof opts.onToken === 'function' ? opts.onToken : null;

  _genGenerating = true;
  const ctl = new AbortController();
  _genAbortCtl = ctl;
  if(opts.signal){
    if(opts.signal.aborted){ ctl.abort(); }
    else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true });
  }

  try{
    // Route aborts through InterruptableStoppingCriteria when available so
    // decoding halts immediately instead of continuing in the background.
    ctl.signal.addEventListener('abort', () => {
      if(_genStoppingCriteria && typeof _genStoppingCriteria.interrupt === 'function'){
        try{ _genStoppingCriteria.interrupt(); }catch(e){}
      }
    }, { once: true });

    const tokenizer = _genPipe.tokenizer;
    let inputs;
    if(Array.isArray(opts.messages) && typeof tokenizer.apply_chat_template === 'function'){
      inputs = tokenizer.apply_chat_template(opts.messages, { tokenize: false, add_generation_prompt: true });
    } else if(typeof opts.prompt === 'string'){
      inputs = opts.prompt;
    } else {
      throw new Error('GEN_NO_INPUT');
    }

    let streamer = null;
    let stopping = null;
    try{
      const mod = await _importTransformers();
      if(mod && mod.TextStreamer && onToken){
        streamer = new mod.TextStreamer(tokenizer, {
          skip_prompt: true,
          skip_special_tokens: true,
          callback_function: (t) => { try{ onToken(t); }catch(e){} },
        });
      }
      if(mod && mod.InterruptableStoppingCriteria){
        stopping = new mod.InterruptableStoppingCriteria();
        _genStoppingCriteria = stopping;
      }
    }catch(e){
      // streaming/stopping criteria are best-effort; generation still works without them.
    }

    const generateOpts = {
      max_new_tokens: maxTokens,
      do_sample: temperature > 0,
      temperature: temperature,
      return_full_text: false,
      streamer,
    };
    if(stopping) generateOpts.stopping_criteria = stopping;

    const out = await _genPipe(inputs, generateOpts);

    if(ctl.signal.aborted) throw new Error('GEN_ABORTED');

    if(Array.isArray(out) && out.length){
      const first = out[0];
      if(first && typeof first.generated_text === 'string') return first.generated_text;
    }
    return '';
  } finally {
    // Always clear transient state, even on throw, so the next genAbort()
    // can't target a stale controller / criteria object.
    _genStoppingCriteria = null;
    if(_genAbortCtl === ctl) _genAbortCtl = null;
    _genGenerating = false;
  }
}

if(typeof window !== 'undefined'){
  window.GEN_MODEL_PRESETS = GEN_MODEL_PRESETS;
  window.GEN_MODEL_ALT_SLUGS = GEN_MODEL_ALT_SLUGS;
  window.getGenPresets = getGenPresets;
  window.getGenCfg = getGenCfg;
  window.saveGenCfg = saveGenCfg;
  window.genLoad = genLoad;
  window.genAbortLoad = genAbortLoad;
  window.genGenerate = genGenerate;
  window.genAbort = genAbort;
  window.isGenReady = isGenReady;
  window.isGenLoading = isGenLoading;
  window.isGenGenerating = isGenGenerating;
  window.isGenBusy = isGenBusy;
  window.isGenDownloaded = isGenDownloaded;
  window.markGenDownloaded = markGenDownloaded;
  window.getGenDevice = getGenDevice;
  window.getGenModel = getGenModel;
  window.getGenLastError = getGenLastError;
  window.clearGenLastError = clearGenLastError;
  window.getAskHistory = getAskHistory;
  window.pushAskHistory = pushAskHistory;
  window.clearAskHistory = clearAskHistory;
  window.clearLLMCache = clearLLMCache;
  window._mobileRamHint = _mobileRamHint;
}
