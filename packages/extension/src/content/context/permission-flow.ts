/**
 * In-page explainer shown before triggering the real browser permission prompt.
 * Context: the browser's native getUserMedia dialog is terse — this pre-prompt
 * explains *why* AccessBridge is asking and what is (and isn't) collected, so
 * users aren't surprised when the camera/mic permission request appears.
 *
 * Returns a promise that resolves to 'accept' or 'deny'. Only on 'accept' should
 * the caller invoke getUserMedia.
 */

export type PermissionChoice = 'accept' | 'deny';

export interface PermissionFlowOptions {
  wantLight: boolean;
  wantNoise: boolean;
}

const STORAGE_KEY = 'a11y-env-permission-decision';

export async function getStoredDecision(): Promise<PermissionChoice | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const val = result[STORAGE_KEY];
    if (val === 'accept' || val === 'deny') return val;
  } catch {
    /* storage not available — treat as no prior decision */
  }
  return null;
}

async function storeDecision(choice: PermissionChoice): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: choice });
  } catch {
    /* non-fatal */
  }
}

export async function clearStoredDecision(): Promise<void> {
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch {
    /* non-fatal */
  }
}

export function showPermissionExplainer(options: PermissionFlowOptions): Promise<PermissionChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'a11y-env-explainer-overlay';

    const card = document.createElement('div');
    card.className = 'a11y-env-explainer-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'a11y-env-explainer-title');

    const title = document.createElement('h2');
    title.id = 'a11y-env-explainer-title';
    title.textContent = 'Environment Sensing';
    card.appendChild(title);

    const body = document.createElement('div');
    body.className = 'a11y-env-explainer-body';

    const intro = document.createElement('p');
    const accessed: string[] = [];
    if (options.wantLight) accessed.push('your webcam');
    if (options.wantNoise) accessed.push('your microphone');
    intro.textContent = `AccessBridge would like to access ${accessed.join(' and ')} to sense your surroundings every 15–30 seconds. This helps us adapt contrast, text size, and voice-command reliability to your environment.`;
    body.appendChild(intro);

    const whatList = document.createElement('ul');
    whatList.className = 'a11y-env-explainer-list';
    const whatItems: string[] = [];
    if (options.wantLight) whatItems.push('A tiny 160×120 webcam frame is instantly averaged to one brightness number.');
    if (options.wantNoise) whatItems.push('A one-second microphone sample is instantly reduced to one loudness number.');
    whatItems.push('Raw images and audio are discarded in the same instant — never stored, logged, or transmitted.');
    whatItems.push('Your browser will now ask for permission. You can revoke at any time.');
    for (const text of whatItems) {
      const li = document.createElement('li');
      li.textContent = text;
      whatList.appendChild(li);
    }
    body.appendChild(whatList);
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'a11y-env-explainer-actions';

    const denyBtn = document.createElement('button');
    denyBtn.className = 'a11y-env-explainer-btn a11y-env-explainer-btn--deny';
    denyBtn.textContent = 'Not now';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'a11y-env-explainer-btn a11y-env-explainer-btn--accept';
    acceptBtn.textContent = 'Continue';

    const finish = (choice: PermissionChoice): void => {
      storeDecision(choice).finally(() => {
        if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
        resolve(choice);
      });
    };

    denyBtn.addEventListener('click', () => finish('deny'));
    acceptBtn.addEventListener('click', () => finish('accept'));

    actions.appendChild(denyBtn);
    actions.appendChild(acceptBtn);
    card.appendChild(actions);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    // Defer focus so the screen reader picks up the dialog role first.
    setTimeout(() => acceptBtn.focus(), 50);
  });
}
