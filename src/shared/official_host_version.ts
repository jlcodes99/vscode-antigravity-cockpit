import * as fs from 'fs';
import * as path from 'path';

const OFFICIAL_PRODUCT_JSON_PATH = path.join(process.resourcesPath, 'app', 'product.json');

let cachedOfficialIdeVersion: string | null | undefined;

export function getOfficialProductJsonPath(): string {
    return OFFICIAL_PRODUCT_JSON_PATH;
}

export function getOfficialIdeVersion(): string | null {
    if (cachedOfficialIdeVersion !== undefined) {
        return cachedOfficialIdeVersion;
    }

    try {
        const raw = fs.readFileSync(OFFICIAL_PRODUCT_JSON_PATH, 'utf8');
        const product = JSON.parse(raw) as { ideVersion?: unknown };
        const ideVersion = typeof product.ideVersion === 'string' ? product.ideVersion.trim() : '';
        cachedOfficialIdeVersion = ideVersion || null;
        return cachedOfficialIdeVersion;
    } catch {
        cachedOfficialIdeVersion = null;
        return null;
    }
}
