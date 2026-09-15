# 私有 GitLab 创建仓库 API 指南

> 环境实例：`http://172.29.100.126`（GitLab Community Edition，老版本，仅 HTTP，不支持 SSH）
> 账号：`codigger-llm`（kfjllm 上 `~/.git-credentials` 已存 PAT，push 免密）

## 1. 前置条件：必须用 PAT，密码不行

该 GitLab 账号开启了 2FA，**密码对 API 和 git-over-HTTP 都返回 401**，必须创建 Personal Access Token（PAT）：

```bash
# 密码方式会失败（已验证）：
curl -u "codigger-llm:密码" "http://172.29.100.126/api/v4/user"
# => {"message":"401 Unauthorized"}
```

### 创建 PAT

**方式一：Web UI（推荐）**

登录 http://172.29.100.126 → 右上角头像 → Settings → Access Tokens
（老版本路径为 `/profile/personal_access_tokens`，新版为 `/-/user_settings/personal_access_tokens`）

- Name: 自定义（如 `mimocode-cli`）
- Scopes: 勾选 `api`（建仓库 + push 都够用）
- Expires at: 可留空（永不过期）

**方式二：curl 模拟 web 会话**（适合无浏览器环境，本次实际使用的方法）

```bash
BASE=http://172.29.100.126
JAR=/tmp/gl_session.jar

# 1. 登录拿 session
T=$(curl -s -c $JAR $BASE/users/sign_in \
    | grep -o 'name="authenticity_token" value="[^"]*"' | head -1 \
    | sed 's/.*value="//; s/"$//')
curl -s -b $JAR -c $JAR -o /dev/null -X POST $BASE/users/sign_in \
    --data-urlencode "authenticity_token=$T" \
    --data-urlencode "user[login]=codigger-llm" \
    --data-urlencode "user[password]=<密码>"

# 2. 提交 PAT 创建表单
T=$(curl -s -b $JAR $BASE/profile/personal_access_tokens \
    | grep -o 'name="authenticity_token" value="[^"]*"' | head -1 \
    | sed 's/.*value="//; s/"$//')
curl -s -b $JAR -c $JAR -o /dev/null -X POST $BASE/profile/personal_access_tokens \
    --data-urlencode "authenticity_token=$T" \
    --data-urlencode "utf8=✓" \
    --data-urlencode "personal_access_token[name]=mimocode-cli" \
    --data-urlencode "personal_access_token[scopes][]=api" \
    --data-urlencode "personal_access_token[expires_at]="

# 3. 重新访问页面提取新 token
curl -s -b $JAR $BASE/profile/personal_access_tokens \
    | grep -o 'id="created-personal-access-token"[^>]*value="[^"]*"'
```

## 2. API 创建私有仓库

```bash
PAT=<你的PAT>
curl -s -H "PRIVATE-TOKEN: $PAT" \
    -X POST "http://172.29.100.126/api/v4/projects" \
    --data "name=llmbugfix" \
    --data "visibility=private"
```

关键参数：

| 参数 | 说明 |
|------|------|
| `name` | 项目显示名（必填） |
| `path` | URL 路径，缺省同 name |
| `visibility` | `private` / `internal` / `public`，私有必须显式传 `private` |
| `namespace_id` | 不传则建在个人空间下；建到组里需先查组 ID |

成功返回项目 JSON（含 `id`、`http_url_to_repo`、`web_url` 等）。

### 验证

```bash
# 查看仓库信息（URL 编码的路径：/ → %2F）
curl -s -H "PRIVATE-TOKEN: $PAT" \
    "http://172.29.100.126/api/v4/projects/codigger-llm%2Fllmbugfix" \
    | grep -o '"visibility":"[a-z]*"'
# => "visibility":"private"

# 查看提交
curl -s -H "PRIVATE-TOKEN: $PAT" \
    "http://172.29.100.126/api/v4/projects/codigger-llm%2Fllmbugfix/repository/commits?per_page=1"
```

## 3. 本地推送配置

```bash
# PAT 存入凭据（配合 credential.helper=store，之后 push 免密）
# ~/.git-credentials 格式：
# http://codigger-llm:<PAT>@172.29.100.126

git remote add origin http://172.29.100.126/codigger-llm/llmbugfix.git
git push -u origin master
```

## 4. 踩坑记录（2026-09-15 实测）

1. **SSH 不可用**：该 GitLab 只开放 HTTP，`git@172.29.100.126:22` 连接超时，SSH key 无用武之地。
2. **密码 401**：账号开 2FA 后，密码仅限 web 登录，API / git push 一律用 PAT。
3. **pre-receive hook 强制作者名校验**：服务端 hook 要求提交作者名 = GitLab 登录账号名，否则拒绝推送。历史提交作者不符时需重写：
   ```bash
   git branch backup-before-rewrite   # 先备份
   git stash push -u                  # 工作区有未提交改动时先 stash
   git filter-branch -f --env-filter '
       export GIT_AUTHOR_NAME="codigger-llm"
       export GIT_AUTHOR_EMAIL="codigger@onecloud.cn"
       export GIT_COMMITTER_NAME="codigger-llm"
       export GIT_COMMITTER_EMAIL="codigger@onecloud.cn"
   ' -- --all
   git stash pop                      # 恢复 WIP
   ```
   注意：重写会改变所有 commit hash，文件内容不变（`git diff backup-before-rewrite master` 为空）。
4. **老版本路径差异**：PAT 页面路径是 `/profile/personal_access_tokens`（无 `/-/` 前缀），`/-/profile` 等 404。
