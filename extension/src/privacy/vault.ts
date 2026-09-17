// A tiny local answer store for the ask_user flow (see background/index.ts): once someone
// answers "what should I put in the 'Company Name' field?", the answer is remembered here so
// the same field on a future page never has to be asked twice. This is entirely local --
// chrome.storage.local never syncs off the device and this module is never imported by
// anything that talks to the server -- so it doesn't weaken the "answers are never sent to
// the planner" guarantee the ask_user feature was built on.
const VAULT_PREFIX = "askvault:";

function normalizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function getVaultAnswer(label: string): Promise<string | null> {
  const key = VAULT_PREFIX + normalizeLabel(label);
  if (key === VAULT_PREFIX) return null; // empty/unusable label -- nothing to key it by
  const stored = await chrome.storage.local.get(key);
  return stored[key]?.value ?? null;
}

export async function saveVaultAnswer(label: string, value: string): Promise<void> {
  const key = VAULT_PREFIX + normalizeLabel(label);
  if (key === VAULT_PREFIX || !value.trim()) return;
  await chrome.storage.local.set({ [key]: { value, updatedAt: Date.now() } });
}

export async function clearVault(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(VAULT_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}
