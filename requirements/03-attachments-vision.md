# WP03：附件、脱敏与可选 Vision（Phase 7–8）

## 目标

安全保存 PNG/JPG/JPEG/WEBP/TXT/LOG/JSON/HAR/MP4，解析文本附件并让图片理解保持完全可选。

## 文件所有权

- `packages/attachment-service/**`
- `packages/vision-provider/**`
- `apps/bug-api` 中 attachment/internal vision 路由文件（不得改公共启动骨架，需导出路由插件）。

## 必须实现

- 文件位于 `data/attachments/<BUG-ID>/`；数据库仅保存 metadata。
- allowlist MIME + 扩展名双校验、大小限制、安全文件名、路径穿越防护、SHA-256。
- TXT/LOG/JSON/HAR 有界提取；JSON/HAR 校验；MP4 与图片只保存。
- 检测并 redact Bearer、password、Cookie、API key、private key、JWT、AWS key；日志不得输出原文 secret。
- VisionProvider、OcrProvider 接口；DisabledVisionProvider 默认；HTTP provider 仅指向配置的内网 URL，并带 timeout。
- Vision 不可用/故障时上传和提交正常，analysis 状态准确，并返回固定的“请描述截图”提示。
- machineObservations 与 reporterObservations 分离，不得把机器输出冒充用户事实。

## 验收

- 每种允许类型上传测试；拒绝伪装扩展名、超限、路径穿越和未知类型。
- secret 在 extractedText、DB、日志中均被替换。
- `VISION_ENABLED=false` 端到端上传并提交图片成功，且没有图片已理解声明。
- HTTP Vision 故障自动降级且平台不崩溃。

