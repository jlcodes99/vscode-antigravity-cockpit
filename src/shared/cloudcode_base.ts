/**
 * Cloud Code URL routing aligned with Antigravity desktop app.
 */

export const CLOUDCODE_URL_AUTOPUSH_SANDBOX = 'https://autopush-cloudcode-pa.sandbox.googleapis.com';
export const CLOUDCODE_URL_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
export const CLOUDCODE_URL_PROD = 'https://cloudcode-pa.googleapis.com';

export interface CloudCodeRouteOptions {
    isGcpTos?: boolean;
    isGoogleInternal?: boolean;
    isInsiders?: boolean;
    isDev?: boolean;
    cloudCodeUrlOverride?: string;
}

export function resolveCloudCodeBaseUrl(route?: CloudCodeRouteOptions): string {
    if (route?.cloudCodeUrlOverride) {
        return route.cloudCodeUrlOverride;
    }
    if (route?.isGcpTos) {
        return CLOUDCODE_URL_PROD;
    }
    if (route?.isGoogleInternal && (route.isInsiders || route.isDev)) {
        return CLOUDCODE_URL_AUTOPUSH_SANDBOX;
    }
    return CLOUDCODE_URL_DAILY;
}

export function buildCloudCodeUrl(baseUrl: string, path: string): string {
    return `${baseUrl}${path}`;
}
