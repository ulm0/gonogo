/** Flight Rules, LOGIN: which names gonogo answers on, and whether the login stands behind them (docs/expose-spec.md). */
export interface ExposureView {
  pages: string[];
  hooks: string[];
  publicUrl: string | null;
}

export function exposureText(exposure: ExposureView | undefined, login: string, mfa: boolean): { line: string; warn: boolean } {
  const pages = exposure?.pages ?? [];
  const hooks = exposure?.hooks ?? [];
  if (pages.length === 0 && hooks.length === 0) return { line: 'Exposed to: this machine and your local network only (no --allow-host).', warn: false };
  const parts = [...pages.map((p) => `${p} (page)`), ...hooks.map((h) => `${h} (webhooks only)`)];
  const ready = login === 'account' && mfa;
  return { line: `Exposed to: ${parts.join(', ')}. Login: ${ready ? 'ready (account and second factor)' : login === 'account' ? 'account only: turn on the second factor, a public login needs it' : 'not set up'}.${exposure?.publicUrl == null ? '' : ` Public address: ${exposure.publicUrl}.`}`, warn: pages.length > 0 && !ready };
}
