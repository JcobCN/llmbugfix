import { describe, expect, it } from 'vitest';
import { renderIndexHtml } from './index.js';
describe('conversational intake page', () => {
    it('uses an editable Markdown document instead of a structured draft form', () => {
        const html = renderIndexHtml();
        expect(html).toContain('id="markdown-editor"');
        expect(html).toContain('document-save-state');
        expect(html).toContain('document-sync-state');
        expect(html).toContain('flushDocument');
        expect(html).toContain('handleDocumentConflict');
        expect(html).toContain('reload-server-document');
        expect(html).toContain('setEditorDirty');
        expect(html).toContain('saveTimer=setTimeout');
        expect(html).toContain('await flushDocument()');
        expect(html).toContain('e.data&&e.data.document');
        expect(html).toContain('本地编辑已保留');
        expect(html).toContain("localDirty=$('markdown-editor').value!==content");
        expect(html).not.toContain('id="title"');
        expect(html).not.toContain('id="target"');
        expect(html).not.toContain('id="profile"');
        expect(html).not.toContain('id="actual"');
        expect(html).not.toContain('id="expected"');
        expect(html).not.toContain('id="steps"');
        expect(html).not.toContain('Save draft');
    });
});
//# sourceMappingURL=index.test.js.map