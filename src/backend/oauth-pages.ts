const page = (title: string, body: string) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} · OpenList catsuki Drive</title>
  <style>
    body{max-width:760px;margin:40px auto;padding:0 20px;color:#202124;background:#fff;font:16px/1.7 system-ui,sans-serif}
    h1{font-size:1.8rem}h2{font-size:1.2rem;margin-top:1.8rem}
    a{color:#0759b3}nav{display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:2rem}
    footer{border-top:1px solid #ddd;margin-top:2rem;padding-top:1rem;color:#555;font-size:.9rem}
  </style>
</head>
<body>
  <nav><a href="/oauth-info">应用说明</a><a href="/privacy">隐私政策</a><a href="/terms">使用条款</a></nav>
  <main>${body}</main>
  <footer>OpenList catsuki Drive · <a href="mailto:acnekot@gmail.com">acnekot@gmail.com</a> · 更新于 2026-09-29</footer>
</body>
</html>`

const pages: Record<string, string> = {
  '/oauth-info': page('应用说明', `
    <h1>OpenList catsuki Drive</h1>
    <p>这是站点所有者用于访问本人 Google 云端硬盘的私人文件列表。站点运行在 Cloudflare Workers，配置保存在 Cloudflare D1；访客不能浏览或下载云盘内容。</p>
    <p>应用仅请求 <code>drive.readonly</code> 权限，用于列出文件夹、显示文件信息和按所有者的请求读取或下载文件。应用没有 Google Drive 写入权限。</p>
    <p>云盘管理入口需要站点管理员登录。有关数据处理方式和使用规则，请阅读<a href="/privacy">隐私政策</a>和<a href="/terms">使用条款</a>。</p>
  `),
  '/privacy': page('隐私政策', `
    <h1>隐私政策</h1>
    <p>OpenList catsuki Drive 供站点所有者个人使用。只有站点所有者可登录云盘管理入口。</p>
    <h2>访问的数据与用途</h2>
    <p>在所有者通过 Google 授权后，应用使用 Google Drive 的只读权限读取文件夹、文件名、大小等信息，并按所有者的操作读取文件内容，以提供目录浏览、预览和下载。应用不会修改或删除 Google Drive 文件。</p>
    <h2>存储与传输</h2>
    <p>OAuth 授权配置和站点账户配置保存在所有者的 Cloudflare D1 中，其中敏感字段使用加密存储。文件下载经 Cloudflare Workers 从 Google Drive 流式传输；文件内容不作为站点的永久副本写入 D1。Cloudflare 和 Google 会为提供这些服务而处理相关请求数据。站点可能临时缓存目录信息，并产生必要的服务运行日志。</p>
    <h2>共享与保留</h2>
    <p>应用不出售 Google 用户数据，也不将其用于广告。云盘内容默认仅对已登录的管理员开放。所有者可在站点管理界面移除存储配置，并可在 Google 账号的第三方连接设置中撤销 OAuth 授权。</p>
    <h2>联系</h2>
    <p>如需询问或请求删除站点中的授权配置，请联系 <a href="mailto:acnekot@gmail.com">acnekot@gmail.com</a>。</p>
  `),
  '/terms': page('使用条款', `
    <h1>使用条款</h1>
    <p>OpenList catsuki Drive 是站点所有者的私人文件访问工具。云盘目录、预览和下载仅供获得管理员授权的人使用；不得尝试绕过登录或下载保护。</p>
    <p>站点所有者负责其云盘文件的内容及合法使用。服务依赖 Google Drive 和 Cloudflare，可能因这些服务的可用性或授权状态而中断。</p>
    <p>站点所有者可调整或停止此私人服务。如需联系，请发送邮件至 <a href="mailto:acnekot@gmail.com">acnekot@gmail.com</a>。</p>
  `),
}

export function getOAuthPage(pathname: string): string | undefined {
  return pages[pathname]
}
