// Durable Object（SQLite＋WebSocket）。cloudflare:workers を直接 import してよい唯一の場所
// M0 では中身を持たない。依存の向きだけを固定する（01-repo-bootstrap.md §3.2）。

export const PACKAGE_NAME = "@musubi/app-do" as const;
