/** True only for http(s) URLs whose host is localhost / 127.0.0.1 / ::1. */
export function isLocalRpc(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}
