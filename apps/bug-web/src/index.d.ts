/** Dependency-free browser pages. Intake deliberately exposes conversation + Markdown only. */
export declare function renderIndexHtml(): string;
/** Dashboard is deliberately server-rendered as a tiny dependency-free page.
 * All state comes from the API, so refreshes never expose a stale in-memory UI. */
export declare function renderDashboardHtml(): string;
/** Detail view intentionally renders all pipeline sections, including sections
 * that are not available until the worker reaches that stage. */
export declare function renderDetailHtml(bugId?: string): string;
//# sourceMappingURL=index.d.ts.map