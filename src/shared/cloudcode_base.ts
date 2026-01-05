/**
 * Cloud Code API base URLs (primary + fallback)
 */

export const CLOUDCODE_BASE_URLS = [
    'https://cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
] as const;

export function buildCloudCodeUrl(baseUrl: string, path: string): string {
    return `${baseUrl}${path}`;
}
