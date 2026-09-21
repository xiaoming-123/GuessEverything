# -*- coding: utf-8 -*-
"""阶段 6 封面后期：cover_v1.png（干净底图）+ 真实字体标题层 -> cover_v2.png
幂等可重跑；字体=系统楷体（避免 AI 生图伪汉字）。用法：
  D:/soft/conda/python.exe C:/Project/Ai/GuessEverything/scripts/cover-title.py
"""
from PIL import Image, ImageDraw, ImageFont

SRC = r"C:/Project/Ai/GuessEverything/public/art/cover_v1.png"
DST = r"C:/Project/Ai/GuessEverything/public/art/cover_v2.png"
KAI = r"C:/Windows/Fonts/simkai.ttf"
HEI = r"C:/Windows/Fonts/simhei.ttf"

# 主题色（与前端 indigo/amber 一致）
GOLD = (245, 184, 65, 255)        # 琥珀金
GOLD_HI = (255, 214, 120, 255)    # 亮金渐变上端
INDIGO = (30, 36, 76, 255)        # 深靛蓝（描边/阴影）
MIST = (120, 135, 165, 220)       # 底部声明灰蓝


def draw_title_layer(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    W, H = img.size  # 1024x1024
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    # ---- 主标题「谜盒」（上部天空区居中；楷体，金渐层由描边+双层模拟） ----
    f_main = ImageFont.truetype(KAI, 168)
    text = "谜盒"
    tb = d.textbbox((0, 0), text, font=f_main)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    x = (W - tw) // 2 - tb[0]
    y = int(H * 0.10) - tb[1]
    # 深靛蓝阴影/描边（多向偏移）
    for dx, dy in [(-5, 5), (5, 5), (-5, 0), (5, 0), (0, 6), (-4, -4), (4, -4)]:
        d.text((x + dx, y + dy), text, font=f_main, fill=INDIGO)
    # 主体：亮金 -> 琥珀金（两层错位模拟渐变）
    d.text((x, y), text, font=f_main, fill=GOLD)
    clip = Image.new("L", (W, H), 0)
    ImageDraw.Draw(clip).rectangle((0, y, W, y + th // 2), fill=255)
    hi = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(hi).text((x, y), text, font=f_main, fill=GOLD_HI)
    overlay = Image.composite(hi, overlay, clip)
    d = ImageDraw.Draw(overlay)

    # ---- 副标题「诗词升官」 ----
    f_sub = ImageFont.truetype(KAI, 58)
    sub = "诗词升官"
    sb = d.textbbox((0, 0), sub, font=f_sub)
    sw = sb[2] - sb[0]
    sx = (W - sw) // 2 - sb[0]
    sy = y + th + int(H * 0.028) - sb[1]
    for dx, dy in [(-3, 3), (3, 3), (0, 4), (-2, -2), (2, -2)]:
        d.text((sx + dx, sy + dy), sub, font=f_sub, fill=INDIGO)
    d.text((sx, sy), sub, font=f_sub, fill=(255, 244, 214, 255))

    # ---- 两侧金色分隔线（副标题下） ----
    line_y = sy + (sb[3] - sb[1]) + int(H * 0.025)
    gap = sw // 2 + 40
    d.line([(W // 2 - gap, line_y), (W // 2 - gap + 110, line_y)], fill=GOLD, width=3)
    d.line([(W // 2 + gap - 110, line_y), (W // 2 + gap, line_y)], fill=GOLD, width=3)

    # ---- 底部合规声明（白雾区小字，低对比） ----
    f_note = ImageFont.truetype(HEI, 26)
    note = "架空称号 · 非真实官制"
    nb = d.textbbox((0, 0), note, font=f_note)
    nw = nb[2] - nb[0]
    d.text(((W - nw) // 2 - nb[0], H - int(H * 0.045) - nb[1]), note, font=f_note, fill=MIST)

    return Image.alpha_composite(img, overlay).convert("RGB")


def main() -> None:
    base = Image.open(SRC)
    out = draw_title_layer(base)
    out.save(DST, "PNG", optimize=True)
    print(f"saved {DST} size={out.size}")


if __name__ == "__main__":
    main()
