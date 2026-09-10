import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
function resolvePublicDir() {
    const currentDir = fileURLToPath(new URL('.', import.meta.url));
    const candidates = [
        resolve(currentDir, '../public'),
        resolve(currentDir, 'public'),
        resolve(process.cwd(), 'apps/bug-web/public'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    throw new Error(`Unable to locate apps/bug-web public directory from ${currentDir}`);
}
const publicDir = resolvePublicDir();
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};
const ASSET_FILES = [
    'intake.html',
    'intake.css',
    'intake.js',
    'dashboard.html',
    'dashboard.css',
    'dashboard.js',
    'detail.html',
    'detail.css',
    'detail.js',
];
function loadAsset(filename) {
    const filePath = resolve(publicDir, filename);
    const body = readFileSync(filePath, 'utf8');
    const ext = extname(filename);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = {
        'cache-control': 'no-cache',
    };
    return { body, contentType, headers };
}
const staticAssets = new Map();
for (const filename of ASSET_FILES) {
    const asset = loadAsset(filename);
    staticAssets.set(`/static/${filename}`, asset);
}
const intakeHtml = staticAssets.get('/static/intake.html').body;
const dashboardHtml = staticAssets.get('/static/dashboard.html').body;
const detailHtml = staticAssets.get('/static/detail.html').body;
export const clientScripts = {
    intake: staticAssets.get('/static/intake.js').body,
    dashboard: staticAssets.get('/static/dashboard.js').body,
    detail: staticAssets.get('/static/detail.js').body,
};
export const intakeClientScript = clientScripts.intake;
export const dashboardClientScript = clientScripts.dashboard;
export const detailClientScript = clientScripts.detail;
export function renderIndexHtml() {
    return intakeHtml;
}
export function renderDashboardHtml() {
    return dashboardHtml;
}
export function renderDetailHtml(_bugId = '') {
    return detailHtml;
}
export function getStaticAsset(pathname) {
    const cleanPath = pathname.split('?')[0];
    return staticAssets.get(cleanPath);
}
export function resolveWebRoute(pathname) {
    const cleanPath = pathname.split('?')[0];
    if (cleanPath === '/') {
        return { body: intakeHtml, contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'no-cache' } };
    }
    if (cleanPath === '/dashboard') {
        return { body: dashboardHtml, contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'no-cache' } };
    }
    if (/^\/bugs\/[^/]+$/u.test(cleanPath)) {
        return { body: detailHtml, contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'no-cache' } };
    }
    if (cleanPath.startsWith('/static/')) {
        return getStaticAsset(cleanPath);
    }
    return undefined;
}
//# sourceMappingURL=index.js.map