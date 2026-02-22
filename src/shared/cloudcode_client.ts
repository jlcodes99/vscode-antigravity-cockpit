/**
 * Cloud Code client (routing aligned with Antigravity desktop app)
 */

import * as fs from 'fs';
import * as path from 'path';
import { CloudCodeRouteOptions, resolveCloudCodeBaseUrl, buildCloudCodeUrl } from './cloudcode_base';
import { TIMING } from './constants';
import { logger } from './log_service';

export interface CloudCodeProjectInfo {
    projectId?: string;
    tierId?: string;
}

export interface CloudCodeQuotaResponse {
    models?: Record<string, {
        displayName?: string;
        model?: string;
        quotaInfo?: {
            remainingFraction?: number;
            resetTime?: string;
        };
    }>;
}

export interface CloudCodeResponse<T> {
    data: T;
    text: string;
    baseUrl: string;
    status: number;
}

export interface CloudCodeRequestOptions {
    logLabel?: string;
    timeoutMs?: number;
    maxAttempts?: number;
    route?: CloudCodeRequestRouteOptions;
}

export interface CloudCodeRequestRouteOptions extends CloudCodeRouteOptions {
    cloudaicompanionProject?: string;
    enterpriseProjectId?: string;
}

export class CloudCodeAuthError extends Error {
    readonly status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.name = 'CloudCodeAuthError';
        this.status = status;
    }
}

export class CloudCodeRequestError extends Error {
    readonly status?: number;
    readonly retryable: boolean;
    constructor(message: string, status?: number, retryable: boolean = false) {
        super(message);
        this.name = 'CloudCodeRequestError';
        this.status = status;
        this.retryable = retryable;
    }
}

interface LoadCodeAssistResponse {
    currentTier?: { id?: string };
    paidTier?: { id?: string };
    allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
    cloudaicompanionProject?: unknown;
}

interface OnboardUserResponse {
    name?: string;
    done?: boolean;
    response?: { cloudaicompanionProject?: unknown };
}

const DEFAULT_ATTEMPTS = 2;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 4000;
const ONBOARD_POLL_DELAY_MS = 500;

let cachedIdeVersion: string | null = null;

function getIdeVersion(): string {
    if (cachedIdeVersion) {
        return cachedIdeVersion;
    }

    try {
        const packageJsonPath = path.resolve(__dirname, '../../package.json');
        const content = fs.readFileSync(packageJsonPath, 'utf8');
        const parsed = JSON.parse(content) as { version?: unknown };
        if (typeof parsed.version === 'string' && parsed.version.trim()) {
            cachedIdeVersion = parsed.version.trim();
            return cachedIdeVersion;
        }
    } catch {
        // ignore, fallback below
    }

    cachedIdeVersion = 'unknown';
    return cachedIdeVersion;
}

function normalizeUserAgentPlatform(value: NodeJS.Platform): string {
    return value === 'win32' ? 'windows' : value;
}

function normalizeUserAgentArch(value: string): string {
    switch (value) {
        case 'x64':
            return 'amd64';
        case 'ia32':
            return '386';
        default:
            return value;
    }
}

function getCloudCodeMetadata(): Record<string, string> {
    return {
        ideName: 'antigravity',
        ideType: 'ANTIGRAVITY',
        ideVersion: getIdeVersion(),
    };
}

function getCloudCodeUserAgent(): string {
    const ideVersion = getIdeVersion();
    const platform = normalizeUserAgentPlatform(process.platform);
    const arch = normalizeUserAgentArch(process.arch);
    return `antigravity/${ideVersion} ${platform}/${arch}`;
}

export class CloudCodeClient {
    async loadProjectInfo(
        accessToken: string,
        options?: CloudCodeRequestOptions,
    ): Promise<CloudCodeProjectInfo> {
        const data = await this.loadCodeAssistResponse(accessToken, options);

        return {
            projectId: this.extractProjectId(data?.cloudaicompanionProject),
            tierId: data?.paidTier?.id || data?.currentTier?.id,
        };
    }

    async resolveProjectId(
        accessToken: string,
        options?: CloudCodeRequestOptions,
    ): Promise<CloudCodeProjectInfo> {
        const data = await this.loadCodeAssistResponse(accessToken, options);

        const projectId = this.extractProjectId(data?.cloudaicompanionProject);
        const tierId = data?.paidTier?.id || data?.currentTier?.id;
        if (projectId) {
            return { projectId, tierId };
        }

        const allowedTiers = data?.allowedTiers ?? [];
        const onboardTier = this.pickOnboardTier(allowedTiers) || tierId;
        if (!onboardTier) {
            return { projectId: undefined, tierId };
        }

        const onboarded = await this.tryOnboardUser(accessToken, onboardTier, options);
        return { projectId: onboarded ?? undefined, tierId: onboardTier };
    }

    async fetchAvailableModels(
        accessToken: string,
        projectId?: string,
        options?: CloudCodeRequestOptions,
    ): Promise<CloudCodeQuotaResponse> {
        const payload = projectId ? { project: projectId } : {};
        const { data } = await this.requestJson<CloudCodeQuotaResponse>(
            '/v1internal:fetchAvailableModels',
            payload,
            accessToken,
            options,
        );
        return data;
    }

    async requestStream<T>(
        path: string,
        body: object,
        accessToken: string,
        options?: CloudCodeRequestOptions,
    ): Promise<CloudCodeResponse<T>> {
        return this.requestStreamWithRetry<T>(
            this.getRequestBaseUrls(options),
            path,
            body,
            accessToken,
            options,
        );
    }

    async requestJson<T>(
        path: string,
        body: object,
        accessToken: string,
        options?: CloudCodeRequestOptions,
    ): Promise<CloudCodeResponse<T>> {
        return this.requestWithRetry<T>(
            this.getRequestBaseUrls(options),
            path,
            body,
            accessToken,
            options,
        );
    }

    async requestGetJson<T>(
        path: string,
        accessToken: string,
        options?: CloudCodeRequestOptions,
    ): Promise<CloudCodeResponse<T>> {
        return this.requestGetWithRetry<T>(
            this.getRequestBaseUrls(options),
            path,
            accessToken,
            options,
        );
    }

    private getRequestBaseUrls(options?: CloudCodeRequestOptions): readonly string[] {
        return [resolveCloudCodeBaseUrl(options?.route)];
    }

    private async loadCodeAssistResponse(
        accessToken: string,
        options?: CloudCodeRequestOptions,
    ): Promise<LoadCodeAssistResponse> {
        const preferredProjectId = options?.route?.cloudaicompanionProject ?? options?.route?.enterpriseProjectId;
        let data = await this.postLoadCodeAssist(accessToken, preferredProjectId, options);

        const enterpriseProjectId = options?.route?.enterpriseProjectId;
        const hasReturnedProject =
            typeof data?.cloudaicompanionProject === 'string' && data.cloudaicompanionProject !== '';

        // Align with desktop app behavior: retry loadCodeAssist with enterprise project when paidTier is absent.
        if (!data?.paidTier && hasReturnedProject) {
            data = await this.postLoadCodeAssist(accessToken, enterpriseProjectId, options);
        }

        return data;
    }

    private async postLoadCodeAssist(
        accessToken: string,
        cloudaicompanionProject: string | undefined,
        options?: CloudCodeRequestOptions,
    ): Promise<LoadCodeAssistResponse> {
        const payload: Record<string, unknown> = {
            metadata: getCloudCodeMetadata(),
        };
        if (cloudaicompanionProject) {
            payload.cloudaicompanionProject = cloudaicompanionProject;
        }

        const { data } = await this.requestJson<LoadCodeAssistResponse>(
            '/v1internal:loadCodeAssist',
            payload,
            accessToken,
            options,
        );
        return data;
    }

    private async requestStreamWithRetry<T>(
        baseUrls: readonly string[],
        path: string,
        body: object,
        accessToken: string,
        options?: CloudCodeRequestOptions,
    ): Promise<CloudCodeResponse<T>> {
        const maxAttempts = options?.maxAttempts ?? DEFAULT_ATTEMPTS;
        let lastError: Error | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (attempt > 1) {
                const delay = this.getBackoffDelay(attempt);
                logger.info(`${this.formatLabel(options)} Stream retry round ${attempt}/${maxAttempts} in ${delay}ms`);
                await this.sleep(delay);
            }

            for (const baseUrl of baseUrls) {
                try {
                    return await this.requestStreamOnce<T>(baseUrl, path, body, accessToken, options);
                } catch (error) {
                    if (error instanceof CloudCodeAuthError) {
                        throw error;
                    }
                    lastError = error instanceof Error ? error : new Error(String(error));
                    const retryable = error instanceof CloudCodeRequestError ? error.retryable : true;
                    if (!retryable) {
                        throw lastError;
                    }
                    if (baseUrl !== baseUrls[baseUrls.length - 1]) {
                        logger.warn(
                            `${this.formatLabel(options)} Stream request failed (${baseUrl}${path}), trying fallback: ${lastError.message}`,
                        );
                    }
                }
            }
        }

        throw lastError || new CloudCodeRequestError('Cloud Code stream request failed');
    }

    private async requestGetWithRetry<T>(
        baseUrls: readonly string[],
        path: string,
        accessToken: string,
        options?: CloudCodeRequestOptions,
    ): Promise<CloudCodeResponse<T>> {
        const maxAttempts = options?.maxAttempts ?? DEFAULT_ATTEMPTS;
        let lastError: Error | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (attempt > 1) {
                const delay = this.getBackoffDelay(attempt);
                logger.info(`${this.formatLabel(options)} GET retry round ${attempt}/${maxAttempts} in ${delay}ms`);
                await this.sleep(delay);
            }

            for (const baseUrl of baseUrls) {
                try {
                    return await this.requestGetOnce<T>(baseUrl, path, accessToken, options);
                } catch (error) {
                    if (error instanceof CloudCodeAuthError) {
                        throw error;
                    }
                    lastError = error instanceof Error ? error : new Error(String(error));
                    const retryable = error instanceof CloudCodeRequestError ? error.retryable : true;
                    if (!retryable) {
                        throw lastError;
                    }
                    if (baseUrl !== baseUrls[baseUrls.length - 1]) {
                        logger.warn(
                            `${this.formatLabel(options)} GET request failed (${baseUrl}${path}), trying fallback: ${lastError.message}`,
                        );
                    }
                }
            }
        }

        throw lastError || new CloudCodeRequestError('Cloud Code GET request failed');
    }

    private async requestWithRetry<T>(
        baseUrls: readonly string[],
        path: string,
        body: object,
        accessToken: string,
        options?: CloudCodeRequestOptions,
    ): Promise<CloudCodeResponse<T>> {
        const maxAttempts = options?.maxAttempts ?? DEFAULT_ATTEMPTS;
        let lastError: Error | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (attempt > 1) {
                const delay = this.getBackoffDelay(attempt);
                logger.info(`${this.formatLabel(options)} Retry round ${attempt}/${maxAttempts} in ${delay}ms`);
                await this.sleep(delay);
            }

            for (const baseUrl of baseUrls) {
                try {
                    return await this.requestOnce<T>(baseUrl, path, body, accessToken, options);
                } catch (error) {
                    if (error instanceof CloudCodeAuthError) {
                        throw error;
                    }
                    lastError = error instanceof Error ? error : new Error(String(error));
                    const retryable = error instanceof CloudCodeRequestError ? error.retryable : true;
                    if (!retryable) {
                        throw lastError;
                    }
                    if (baseUrl !== baseUrls[baseUrls.length - 1]) {
                        logger.warn(
                            `${this.formatLabel(options)} Request failed (${baseUrl}${path}), trying fallback: ${lastError.message}`,
                        );
                    }
                }
            }
        }
        throw lastError || new CloudCodeRequestError('Cloud Code request failed');
    }

    private async requestStreamOnce<T>(
        baseUrl: string,
        path: string,
        body: object,
        accessToken: string,
        options?: CloudCodeRequestOptions,
    ): Promise<CloudCodeResponse<T>> {
        const url = buildCloudCodeUrl(baseUrl, path);
        logger.info(`${this.formatLabel(options)} Streaming ${url}`);
        const controller = new AbortController();
        const timeoutMs = options?.timeoutMs ?? TIMING.HTTP_TIMEOUT_MS;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'User-Agent': getCloudCodeUserAgent(),
                    'Content-Type': 'application/json',
                    'Accept-Encoding': 'gzip',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (response.status === 401) {
                throw new CloudCodeAuthError('Authorization expired', response.status);
            }
            if (response.status === 403) {
                throw new CloudCodeRequestError('Cloud Code access forbidden', response.status, false);
            }

            if (!response.ok) {
                const retryable = response.status === 429 || response.status >= 500;
                throw new CloudCodeRequestError(
                    `Cloud Code stream failed (${response.status})`,
                    response.status,
                    retryable,
                );
            }

            if (!response.body) {
                throw new CloudCodeRequestError('Cloud Code stream empty body', response.status, true);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const payloads: string[] = [];
            let lastData: T | undefined;
            let gotEvent = false;

            try {
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        break;
                    }
                    buffer += decoder.decode(value, { stream: true });
                    let newlineIndex: number;
                    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                        const line = buffer.slice(0, newlineIndex).trimEnd();
                        buffer = buffer.slice(newlineIndex + 1);
                        const trimmed = line.trim();
                        if (!trimmed) {
                            continue;
                        }
                        if (!trimmed.startsWith('data:')) {
                            continue;
                        }
                        const payload = trimmed.slice(5).trim();
                        if (payload === '[DONE]') {
                            continue;
                        }
                        gotEvent = true;
                        payloads.push(payload);
                        try {
                            lastData = JSON.parse(payload) as T;
                        } catch {
                            // JSON 解析失败时保留原始文本
                        }
                    }
                }
            } catch (error) {
                const isAbort = error instanceof Error && error.name === 'AbortError';
                if (!(isAbort && gotEvent)) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    throw new CloudCodeRequestError(`Cloud Code stream read error: ${err.message}`, response.status, true);
                }
            } finally {
                try {
                    reader.releaseLock();
                } catch {
                    // ignore
                }
            }

            if (!gotEvent) {
                throw new CloudCodeRequestError('Cloud Code stream received no data', response.status, true);
            }

            return {
                data: lastData as T,
                text: payloads.join('\n'),
                baseUrl,
                status: response.status,
            };
        } finally {
            clearTimeout(timeout);
        }
    }

    private async requestOnce<T>(
        baseUrl: string,
        path: string,
        body: object,
        accessToken: string,
        options?: CloudCodeRequestOptions,
    ): Promise<CloudCodeResponse<T>> {
        const url = buildCloudCodeUrl(baseUrl, path);
        logger.info(`${this.formatLabel(options)} Requesting ${url}`);
        const controller = new AbortController();
        const timeoutMs = options?.timeoutMs ?? TIMING.HTTP_TIMEOUT_MS;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'User-Agent': getCloudCodeUserAgent(),
                    'Content-Type': 'application/json',
                    'Accept-Encoding': 'gzip',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            const text = await response.text();
            if (response.status === 401 || this.isInvalidGrant(text)) {
                throw new CloudCodeAuthError('Authorization expired', response.status);
            }
            if (response.status === 403) {
                throw new CloudCodeRequestError('Cloud Code access forbidden', response.status, false);
            }

            if (!response.ok) {
                const retryable = response.status === 429 || response.status >= 500;
                throw new CloudCodeRequestError(
                    `Cloud Code request failed (${response.status})`,
                    response.status,
                    retryable,
                );
            }

            if (!text) {
                return { data: {} as T, text: '', baseUrl, status: response.status };
            }

            try {
                const parsed = JSON.parse(text) as T;
                return { data: parsed, text, baseUrl, status: response.status };
            } catch (error) {
                throw new CloudCodeRequestError('Cloud Code response parse failed', response.status, true);
            }
        } catch (error) {
            if (error instanceof CloudCodeAuthError || error instanceof CloudCodeRequestError) {
                throw error;
            }

            const err = error instanceof Error ? error : new Error(String(error));
            if (err.name === 'AbortError') {
                throw new CloudCodeRequestError('Cloud Code request timeout', 0, true);
            }
            throw new CloudCodeRequestError(`Cloud Code network error: ${err.message}`, 0, true);
        } finally {
            clearTimeout(timeout);
        }
    }

    private async requestGetOnce<T>(
        baseUrl: string,
        path: string,
        accessToken: string,
        options?: CloudCodeRequestOptions,
    ): Promise<CloudCodeResponse<T>> {
        const url = buildCloudCodeUrl(baseUrl, path);
        logger.info(`${this.formatLabel(options)} Requesting ${url} (GET)`);
        const controller = new AbortController();
        const timeoutMs = options?.timeoutMs ?? TIMING.HTTP_TIMEOUT_MS;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'User-Agent': getCloudCodeUserAgent(),
                    'Content-Type': 'application/json',
                    'Accept-Encoding': 'gzip',
                },
                signal: controller.signal,
            });

            const text = await response.text();
            if (response.status === 401 || this.isInvalidGrant(text)) {
                throw new CloudCodeAuthError('Authorization expired', response.status);
            }
            if (response.status === 403) {
                throw new CloudCodeRequestError('Cloud Code access forbidden', response.status, false);
            }

            if (!response.ok) {
                const retryable = response.status === 429 || response.status >= 500;
                throw new CloudCodeRequestError(
                    `Cloud Code GET request failed (${response.status})`,
                    response.status,
                    retryable,
                );
            }

            if (!text) {
                return { data: {} as T, text: '', baseUrl, status: response.status };
            }

            try {
                const parsed = JSON.parse(text) as T;
                return { data: parsed, text, baseUrl, status: response.status };
            } catch {
                throw new CloudCodeRequestError('Cloud Code response parse failed', response.status, true);
            }
        } catch (error) {
            if (error instanceof CloudCodeAuthError || error instanceof CloudCodeRequestError) {
                throw error;
            }

            const err = error instanceof Error ? error : new Error(String(error));
            if (err.name === 'AbortError') {
                throw new CloudCodeRequestError('Cloud Code request timeout', 0, true);
            }
            throw new CloudCodeRequestError(`Cloud Code network error: ${err.message}`, 0, true);
        } finally {
            clearTimeout(timeout);
        }
    }

    private async tryOnboardUser(
        accessToken: string,
        tierId: string,
        options?: CloudCodeRequestOptions,
    ): Promise<string | null> {
        const payload: Record<string, unknown> = {
            tierId,
            metadata: getCloudCodeMetadata(),
        };
        const cloudaicompanionProject = options?.route?.cloudaicompanionProject ?? options?.route?.enterpriseProjectId;
        if (cloudaicompanionProject) {
            payload.cloudaicompanionProject = cloudaicompanionProject;
        }

        let { data } = await this.requestJson<OnboardUserResponse>(
            '/v1internal:onboardUser',
            payload,
            accessToken,
            options,
        );

        while (!data?.done) {
            const operationName = typeof data?.name === 'string' ? data.name : '';
            if (!operationName) {
                throw new CloudCodeRequestError('Cloud Code onboard operation missing name', 0, true);
            }

            await this.sleep(ONBOARD_POLL_DELAY_MS);
            const result = await this.requestGetJson<OnboardUserResponse>(
                `/v1internal/${operationName}`,
                accessToken,
                options,
            );
            data = result.data;
        }

        const projectId = this.extractProjectId(data?.response?.cloudaicompanionProject);
        return projectId ?? null;
    }

    private extractProjectId(project: unknown): string | undefined {
        if (typeof project === 'string' && project) {
            return project;
        }
        if (project && typeof project === 'object' && 'id' in project) {
            const id = (project as { id?: string }).id;
            if (id) {
                return id;
            }
        }
        return undefined;
    }

    private pickOnboardTier(allowedTiers: Array<{ id?: string; isDefault?: boolean }>): string | undefined {
        const defaultTier = allowedTiers.find(tier => tier?.isDefault && tier.id);
        if (defaultTier?.id) {
            return defaultTier.id;
        }
        const firstTier = allowedTiers.find(tier => tier?.id);
        if (firstTier?.id) {
            return firstTier.id;
        }
        if (allowedTiers.length > 0) {
            return 'LEGACY';
        }
        return undefined;
    }

    private getBackoffDelay(attempt: number): number {
        const raw = BACKOFF_BASE_MS * Math.pow(2, attempt - 2);
        const jitter = Math.random() * 100;
        return Math.min(raw + jitter, BACKOFF_MAX_MS);
    }

    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private isInvalidGrant(text: string): boolean {
        return text.toLowerCase().includes('invalid_grant');
    }

    private formatLabel(options?: CloudCodeRequestOptions): string {
        const label = options?.logLabel ? `CloudCode:${options.logLabel}` : 'CloudCode';
        return `[${label}]`;
    }
}

export const cloudCodeClient = new CloudCodeClient();
