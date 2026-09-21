# P2 生图 seed 台账（2026-09-21）

> 链路：ComfyUI 远程（Z-Image Turbo，steps=8/cfg=1.0/euler/simple/denoise=1.0，896×1152）。
> 文件命名沿用 D5：`q_npc_<key>.png`（入库名去重roll后缀）。

| 资产 | 入库文件 | seed | re-roll 说明 |
| --- | --- | --- | --- |
| 同窗 | `public/art/q_npc_classmate.png` | 9101 | 一次过（竹简书卷无字） |
| 内侍 | `public/art/q_npc_inattendant.png` | 9202 | 9102 废案：卷轴出现「機事杂述」四字伪影 → 9202 改 prompt 显式「卷轴表面完全空白，没有任何文字或图案」一次过 |
| 说书人 | `public/art/q_npc_storyteller.png` | 9103 | 一次过（折扇替代团扇，轻微偏差可接受） |

prompt 见 `docs/design/art-prompts-p2.md`。质检：VISION 逐张（无伪汉字/伪印章/手部/比例错误）。
