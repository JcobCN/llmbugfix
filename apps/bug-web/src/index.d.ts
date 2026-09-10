export type StaticAsset = {
    body: string;
    contentType: string;
    headers?: Record<string, string>;
};
export declare const clientScripts: {
    readonly intake: string;
    readonly dashboard: string;
    readonly detail: string;
};
export declare const intakeClientScript: string;
export declare const dashboardClientScript: string;
export declare const detailClientScript: string;
export declare function renderIndexHtml(): string;
export declare function renderDashboardHtml(): string;
export declare function renderDetailHtml(_bugId?: string): string;
export declare function getStaticAsset(pathname: string): StaticAsset | undefined;
export declare function resolveWebRoute(pathname: string): StaticAsset | undefined;
//# sourceMappingURL=index.d.ts.map