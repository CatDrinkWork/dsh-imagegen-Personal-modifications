# 改动清单（Modifications）

本仓库是上游 [`dickpy/dsh-imagegen`](https://github.com/dickpy/dsh-imagegen)（Apache-2.0）的**个人修改分叉**。
本文件依 Apache-2.0 §4(b) 记录相对上游被修改的文件及改动要点。每个被修改的源文件顶部也带有一段
「NOTICE (Apache-2.0 §4(b))」提示头。

- 上游版权归原作者；完整 Apache-2.0 许可证保留在 [`LICENSE`](./LICENSE)。
- 内嵌第三方提示词素材的 MIT / CC0 署名保留在 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

## 被修改的文件

| 文件 | 改动要点 |
| --- | --- |
| `src/engine.ts` | 单请求生成/下载超时预算调整；多图改为 `Promise.allSettled` + `settleImageBatches` 部分成功聚合（个别失败不毁整批，并保留取消语义）。 |
| `src/agent-image-tools.ts` | Agent 任务总闸 `AGENT_GENERATION_TIMEOUT_MS` 改为分层余量关系式（`UPSTREAM + IMAGE_FETCH + settle margin`），派生自上，避免与单请求预算零余量竞争。 |
| `src/client/ImageGenPanel.tsx` | 图生图支持上传多张参考图（最多 5 张）；失败任务在任务行内联 + 顶部横幅显示具体失败原因。 |
| `src/client/locales.ts` | 为图生图多参考图功能补充 zh / en / ru 文案键。 |
| `src/client/panel.module.css` | 多参考图缩略图样式；新增 `.taskError` 失败原因样式。 |

## 说明
- 以上为本次协作改动中确认修改的文件。若你在其它文件也有本地改动，请一并补加对应文件的「已修改」提示头，并在本表登记，以满足 Apache-2.0 §4(b)。
- 版本号由本仓库维护者自行管理，本清单不涉及版本号变更。
