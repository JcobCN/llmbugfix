import type { BugRepository } from '@llmbugfix/bug-repository';
import { AttachmentService } from '@llmbugfix/attachment-service';
export type AttachmentRouteRequest = {
    method?: string;
    pathname: string;
    body?: Record<string, unknown>;
};
export type AttachmentRouteResponse = {
    status: number;
    body: unknown;
};
export type AttachmentRouteDependencies = {
    attachments: AttachmentService;
    repo?: BugRepository;
};
/**
 * Attachment and internal-vision routes are kept as a small plugin so the API
 * startup skeleton does not acquire a direct dependency on a vision model.
 * Return undefined for paths owned by the normal bug API.
 */
export declare function createAttachmentRoutes(deps: AttachmentRouteDependencies): (request: AttachmentRouteRequest) => Promise<AttachmentRouteResponse | undefined>;
export declare const isAttachmentRouteBody: (value: unknown) => value is Record<string, unknown>;
//# sourceMappingURL=attachment-routes.d.ts.map