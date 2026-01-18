import {existsSync, readFileSync, renameSync, writeFileSync} from 'fs';
import {getServerDataPath} from './paths';

export type S3Config = {
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
    endpoint?: string;
};

export type ServerConfig = {
    domain: string;
    storage: {
        type: 'local-id' | 'local-fullnames' | 's3';
        s3?: S3Config;
    };
    setupCompleted: boolean;
    setupCompletedAt?: string;
};

const CONFIG_FILENAME = 'config.json';

function getConfigPath(): string {
    return getServerDataPath(CONFIG_FILENAME);
}

export function getServerConfig(): ServerConfig | null {
    const path = getConfigPath();
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
        return null;
    }
}

export function saveServerConfig(config: ServerConfig): void {
    const path = getConfigPath();
    const tempPath = path + '.tmp';
    writeFileSync(tempPath, JSON.stringify(config, null, 2));
    renameSync(tempPath, path);
}

export function isSetupCompleted(): boolean {
    const config = getServerConfig();
    return config?.setupCompleted ?? false;
}

export function isSetupRequired(): boolean {
    return !isSetupCompleted();
}

export function getStorageType(): ServerConfig['storage']['type'] {
    const config = getServerConfig();
    return config?.storage.type ?? 'local-id';
}

export function getS3Config(): S3Config | undefined {
    const config = getServerConfig();
    return config?.storage.s3;
}

export function getDomain(): string {
    const config = getServerConfig();
    return config?.domain ?? 'localhost';
}
