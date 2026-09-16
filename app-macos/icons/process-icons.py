#!/usr/bin/env python3
"""从源 PNG（AI 生成的绿底白图）生成全部图标资产：
- iconset（app icon 各尺寸，方形满幅，系统套圆角掩膜）
- menubar template PNG（绿底→透明，白色图形→黑色，alpha bbox 裁剪）
"""
from PIL import Image
import os
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/Downloads/wechat2agent.png')
OUT = os.path.join(os.path.dirname(__file__), 'generated')
os.makedirs(OUT, exist_ok=True)

src = Image.open(SRC).convert('RGB')

# ── 1. App icon iconset ──────────────────────────────────────────────
iconset = os.path.join(OUT, 'AppIcon.iconset')
os.makedirs(iconset, exist_ok=True)
for px, name in [(16, '16x16'), (32, '16x16@2x'), (32, '32x32'), (64, '32x32@2x'),
                 (128, '128x128'), (256, '128x128@2x'), (256, '256x256'), (512, '256x256@2x'),
                 (512, '512x512'), (1024, '512x512@2x')]:
    src.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, f'icon_{name}.png'))
print('iconset done')

# ── 2. 菜单栏 template 图标 ──────────────────────────────────────────
# 背景绿采样（四角 10x10 平均）
w, h = src.size
corners = [src.crop((0, 0, 10, 10)), src.crop((w - 10, 0, w, 10)),
           src.crop((0, h - 10, 10, h)), src.crop((w - 10, h - 10, w, h))]
bg_gray = sum(c.convert('L').getpixel((5, 5)) for c in corners) / 4

gray = src.convert('L')
# alpha 映射：背景灰度 → 0（透明），白色 255 → 255（不透明）
lo, hi = bg_gray + 8, 250  # 少量死区抗噪
lut = [max(0, min(255, round((g - lo) * 255 / (hi - lo)))) for g in range(256)]
alpha = gray.point(lut)

black = Image.new('L', src.size, 0)
white = Image.new('L', src.size, 255)
# 菜单栏多为深色：图形保留白色，背景透明（非 template，固定白色显示）
tpl = Image.merge('RGBA', (white, white, white, alpha))

# 按 alpha bbox 裁剪并留 8% 边距
bbox = tpl.getbbox()
if bbox:
    mx = round((bbox[2] - bbox[0]) * 0.08)
    my = round((bbox[3] - bbox[1]) * 0.08)
    bbox = (max(0, bbox[0] - mx), max(0, bbox[1] - my),
            min(w, bbox[2] + mx), min(h, bbox[3] + my))
    tpl = tpl.crop(bbox)

# 方形化（菜单栏图标需要正方形，短边补齐透明）
tw, th = tpl.size
side = max(tw, th)
square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
square.paste(tpl, ((side - tw) // 2, (side - th) // 2))

for px in (18, 36, 54):
    square.resize((px, px), Image.LANCZOS).save(os.path.join(OUT, f'menubar-{px}.png'))
print('menubar template done, bbox =', bbox)
