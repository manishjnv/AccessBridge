// Session 18 — axe-core injection + postMessage bridge.
//
// axe-core runs only in the page's MAIN world (it introspects document
// globals, computed styles, and the window.axe namespace it installs on
// itself). Content scripts run in the ISOLATED world, so we can't call
// axe.run() directly — instead we inject axe.min.js as a <script src=>
// (loaded from web_accessible_resources) into the page, then inject a
// tiny runner that posts the results back via window.postMessage.
//
// The content-script bundle imports NOTHING from axe-core. axe only ever
// enters the page when the sidepanel asks for it — zero perf cost per
// page load, and no BUG-008/012 IIFE-collision surface.

export interface AxeResultsEnvelope {
  results?: unknown;
  error?: string;
}

let axeLoaderInjected = false;
let axeLoaderPromise: Promise<void> | null = null;

function loadAxeIntoPage(): Promise<void> {
  if (axeLoaderInjected) return Promise.resolve();
  if (axeLoaderPromise) return axeLoaderPromise;
  axeLoaderPromise = new Promise<void>((resolve, reject) => {
    const url = chrome.runtime.getURL('axe.min.js');
    const script = document.createElement('script');
    script.src = url;
    script.async = false;
    script.onload = () => {
      axeLoaderInjected = true;
      script.remove();
      resolve();
    };
    script.onerror = () => {
      script.remove();
      axeLoaderPromise = null;
      reject(new Error(`Failed to load axe-core from ${url}`));
    };
    (document.head ?? document.documentElement).appendChild(script);
  });
  return axeLoaderPromise;
}

/** Run axe-core in the active document and return its raw results.
 *  Rejects on timeout (30 s) or injection failure. Safe to call repeatedly —
 *  the loader is idempotent. */
export async function runAxeInPage(): Promise<AxeResultsEnvelope> {
  await loadAxeIntoPage();

  return new Promise<AxeResultsEnvelope>((resolve) => {
    // CSPRNG nonce — defense in depth against a page using a MutationObserver
    // on document.head to read the runner script's textContent + spoof a
    // forged AB_AXE_RESULT. Page-level observers still CAN race us (script
    // execution is synchronous; MO callbacks are microtasks), but a
    // non-predictable nonce at least removes the "guess ahead of time"
    // vector. crypto.randomUUID is available in all MV3 runtimes.
    const nonce = `ab-axe-${(self.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}-${Date.now()}`)}`;
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ error: 'axe-core timed out after 30s' });
    }, 30_000);

    const handler = (ev: MessageEvent): void => {
      if (ev.source !== window) return;
      const data = ev.data as { type?: string; nonce?: string; results?: unknown; error?: string } | null;
      if (!data || data.type !== 'AB_AXE_RESULT' || data.nonce !== nonce) return;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      if (data.error) resolve({ error: data.error });
      else resolve({ results: data.results });
    };
    window.addEventListener('message', handler);

    // Inject a one-shot runner into the page. We guard against the common
    // CSP case by using textContent on an inline <script>; if a strict CSP
    // blocks it, the onerror path in loadAxeIntoPage or the 30 s timeout
    // will cover it.
    const runner = document.createElement('script');
    runner.textContent =
      `(async function(){try{` +
      `var w=window; if(!w.axe){w.postMessage({type:'AB_AXE_RESULT',nonce:${JSON.stringify(nonce)},error:'axe-not-loaded'},'*');return;}` +
      `var r=await w.axe.run();` +
      `w.postMessage({type:'AB_AXE_RESULT',nonce:${JSON.stringify(nonce)},results:r},'*');` +
      `}catch(e){w.postMessage({type:'AB_AXE_RESULT',nonce:${JSON.stringify(nonce)},error:String(e&&e.message||e)},'*');}})();`;
    (document.head ?? document.documentElement).appendChild(runner);
    runner.remove();
  });
}
