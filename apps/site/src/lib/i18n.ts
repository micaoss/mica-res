export type Lang = "en" | "zh";

const en = {
  hosts: "Hosts",
  hostDownload: "Downloads",
  hostDownloadHint: "Public objects, served directly from storage with range and cache support.",
  hostHome: "Listings and registry",
  hostHomeHint: "Directory listings, legacy URLs, the read-only container registry and the admin console.",
  hostS3: "S3 endpoint",
  hostS3Hint: "Path-style, read-only. The bucket is the namespace.",
  namespaces: "Namespaces",
  objects: "objects",
  protected: "Access key required",
  public: "Public",
  browse: "Browse",
  examples: "Examples",
  access: "Access",
  accessUrl: "Canonical URL",
  accessCurl: "Download a file",
  accessList: "List a directory as JSON",
  accessS3: "List with the AWS CLI",
  accessDocker: "Pull a build-env image",
  copy: "Copy",
  copied: "Copied",
  trustTitle: "Verify what you download",
  trust: "This host is a source, never a trust anchor. Every object is pinned by sha256 in the repository that consumes it; check the digest against your own pin, and fall back to the upstream URL when the mirror does not answer.",
  loading: "Loading…",
  unavailable: "The catalog is not available right now.",
  snapshot: "Catalog",
  published: "published",
  language: "中文",
};

const zh: typeof en = {
  hosts: "服务地址",
  hostDownload: "下载",
  hostDownloadHint: "公开资源直接由存储提供，支持断点续传和缓存。",
  hostHome: "目录与镜像仓库",
  hostHomeHint: "目录列表、旧地址跳转、只读容器镜像仓库和管理后台。",
  hostS3: "S3 接口",
  hostS3Hint: "Path-style，只读。bucket 即命名空间。",
  namespaces: "命名空间",
  objects: "个对象",
  protected: "需要访问密钥",
  public: "公开",
  browse: "浏览",
  examples: "示例路径",
  access: "访问方式",
  accessUrl: "资源地址格式",
  accessCurl: "下载文件",
  accessList: "以 JSON 列出目录",
  accessS3: "用 AWS CLI 列出",
  accessDocker: "拉取构建环境镜像",
  copy: "复制",
  copied: "已复制",
  trustTitle: "校验下载内容",
  trust: "本站是资源来源，不是信任根。每个对象都在使用它的仓库里以 sha256 固定；请用你自己的锁定值校验摘要，镜像不可用时回退到上游地址。",
  loading: "加载中…",
  unavailable: "目录暂时不可用。",
  snapshot: "目录版本",
  published: "发布于",
  language: "English",
};

export type Messages = typeof en;

export function messages(lang: Lang): Messages {
  return lang === "zh" ? zh : en;
}

export function detectLang(stored: string | null, languages: readonly string[]): Lang {
  if (stored === "en" || stored === "zh")
    return stored;
  return languages.some(l => l.toLowerCase().startsWith("zh")) ? "zh" : "en";
}
